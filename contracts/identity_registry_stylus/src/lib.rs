#![cfg_attr(not(any(test, feature = "export-abi")), no_std)]
extern crate alloc;

use alloc::{vec, vec::Vec};

#[cfg(not(any(test, feature = "export-abi")))]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}

use alloy_primitives::{keccak256, Address, FixedBytes, U256};
use stylus_sdk::{abi::Bytes, alloy_sol_types::sol, prelude::*};

/// ERC-8004 Identity Registry (Trustless Agents).
///
/// Each agent is assigned a monotonically increasing `agentId` (starting at
/// 1) and is described by:
///   - `agentDomain`: the agent's resolvable domain/URI (stored as raw bytes
///     since Stylus `sol_storage!` does not support `string`),
///   - `agentAddress`: the on-chain account that controls the agent.
///
/// The registry supports reverse resolution by address and by the keccak256
/// hash of the domain. Off-chain indexers (8004scan) listen to the
/// `AgentRegistered` / `AgentUpdated` events to build the directory.
sol_storage! {
    #[entrypoint]
    pub struct IdentityRegistry {
        // next id to assign (ids start at 1, so this also tracks last id).
        uint256 next_id;
        // agentId => controlling address
        mapping(uint256 => address) agent_addresses;
        // agentId => domain bytes
        mapping(uint256 => bytes) agent_domains;
        // address => agentId (reverse lookup; 0 = none)
        mapping(address => uint256) address_to_id;
        // keccak256(domain) => agentId (reverse lookup; 0 = none)
        mapping(bytes32 => uint256) domain_to_id;
        bool initialized;
    }
}

sol! {
    #[derive(Debug)]
    error AlreadyInitialized();
    #[derive(Debug)]
    error EmptyDomain();
    #[derive(Debug)]
    error ZeroAddress();
    #[derive(Debug)]
    error UnauthorizedCaller();
    #[derive(Debug)]
    error UnknownAgent();
    #[derive(Debug)]
    error AddressAlreadyRegistered();
    #[derive(Debug)]
    error DomainAlreadyRegistered();

    /// Emitted when a new agent is registered.
    event AgentRegistered(
        uint256 indexed agentId,
        address indexed agentAddress,
        bytes32 indexed domainHash,
        bytes agentDomain
    );

    /// Emitted when an agent's domain and/or address is updated.
    event AgentUpdated(
        uint256 indexed agentId,
        address indexed agentAddress,
        bytes32 indexed domainHash,
        bytes agentDomain
    );
}

#[derive(SolidityError, Debug)]
pub enum IdentityError {
    AlreadyInitialized(AlreadyInitialized),
    EmptyDomain(EmptyDomain),
    ZeroAddress(ZeroAddress),
    UnauthorizedCaller(UnauthorizedCaller),
    UnknownAgent(UnknownAgent),
    AddressAlreadyRegistered(AddressAlreadyRegistered),
    DomainAlreadyRegistered(DomainAlreadyRegistered),
}

#[public]
impl IdentityRegistry {
    /// One-time init. Sets the id counter to start at 1.
    pub fn initialize(&mut self) -> Result<(), IdentityError> {
        if self.initialized.get() {
            return Err(IdentityError::AlreadyInitialized(AlreadyInitialized {}));
        }
        self.initialized.set(true);
        self.next_id.set(U256::from(1u64));
        Ok(())
    }

    /// Total number of registered agents.
    #[selector(name = "agentCount")]
    pub fn agent_count(&self) -> U256 {
        let next = self.next_id.get();
        if next == U256::ZERO {
            U256::ZERO
        } else {
            next - U256::from(1u64)
        }
    }

    /// Register a new agent. The caller must be `agent_address` (an agent can
    /// only register itself).
    #[selector(name = "newAgent")]
    pub fn new_agent(
        &mut self,
        agent_domain: Bytes,
        agent_address: Address,
    ) -> Result<U256, IdentityError> {
        if agent_domain.is_empty() {
            return Err(IdentityError::EmptyDomain(EmptyDomain {}));
        }
        if agent_address == Address::ZERO {
            return Err(IdentityError::ZeroAddress(ZeroAddress {}));
        }
        if self.vm().msg_sender() != agent_address {
            return Err(IdentityError::UnauthorizedCaller(UnauthorizedCaller {}));
        }
        if self.address_to_id.get(agent_address) != U256::ZERO {
            return Err(IdentityError::AddressAlreadyRegistered(
                AddressAlreadyRegistered {},
            ));
        }
        let domain_hash = keccak256(agent_domain.as_slice());
        if self.domain_to_id.get(domain_hash) != U256::ZERO {
            return Err(IdentityError::DomainAlreadyRegistered(
                DomainAlreadyRegistered {},
            ));
        }

        let id = self.next_id.get();
        self.agent_addresses.setter(id).set(agent_address);
        self.agent_domains
            .setter(id)
            .set_bytes(agent_domain.as_slice());
        self.address_to_id.setter(agent_address).set(id);
        self.domain_to_id.setter(domain_hash).set(id);
        self.next_id.set(id + U256::from(1u64));

        log(
            self.vm(),
            AgentRegistered {
                agentId: id,
                agentAddress: agent_address,
                domainHash: domain_hash,
                agentDomain: agent_domain.to_vec().into(),
            },
        );
        Ok(id)
    }

    /// Update an existing agent's domain and/or controlling address. Only the
    /// current controlling address may call this.
    #[selector(name = "updateAgent")]
    pub fn update_agent(
        &mut self,
        agent_id: U256,
        new_domain: Bytes,
        new_address: Address,
    ) -> Result<bool, IdentityError> {
        let current = self.agent_addresses.get(agent_id);
        if current == Address::ZERO {
            return Err(IdentityError::UnknownAgent(UnknownAgent {}));
        }
        if self.vm().msg_sender() != current {
            return Err(IdentityError::UnauthorizedCaller(UnauthorizedCaller {}));
        }
        if new_domain.is_empty() {
            return Err(IdentityError::EmptyDomain(EmptyDomain {}));
        }
        if new_address == Address::ZERO {
            return Err(IdentityError::ZeroAddress(ZeroAddress {}));
        }

        // Clear old reverse mappings.
        let old_domain = self.agent_domains.getter(agent_id).get_bytes();
        let old_domain_hash = keccak256(old_domain.as_slice());
        self.domain_to_id.setter(old_domain_hash).set(U256::ZERO);
        self.address_to_id.setter(current).set(U256::ZERO);

        let new_domain_hash = keccak256(new_domain.as_slice());
        // Guard against colliding with a different agent.
        let existing_addr_id = self.address_to_id.get(new_address);
        if existing_addr_id != U256::ZERO && existing_addr_id != agent_id {
            return Err(IdentityError::AddressAlreadyRegistered(
                AddressAlreadyRegistered {},
            ));
        }
        let existing_dom_id = self.domain_to_id.get(new_domain_hash);
        if existing_dom_id != U256::ZERO && existing_dom_id != agent_id {
            return Err(IdentityError::DomainAlreadyRegistered(
                DomainAlreadyRegistered {},
            ));
        }

        self.agent_addresses.setter(agent_id).set(new_address);
        self.agent_domains
            .setter(agent_id)
            .set_bytes(new_domain.as_slice());
        self.address_to_id.setter(new_address).set(agent_id);
        self.domain_to_id.setter(new_domain_hash).set(agent_id);

        log(
            self.vm(),
            AgentUpdated {
                agentId: agent_id,
                agentAddress: new_address,
                domainHash: new_domain_hash,
                agentDomain: new_domain.to_vec().into(),
            },
        );
        Ok(true)
    }

    /// Returns (agentId, agentDomain, agentAddress).
    #[selector(name = "getAgent")]
    pub fn get_agent(
        &self,
        agent_id: U256,
    ) -> Result<(U256, Bytes, Address), IdentityError> {
        let addr = self.agent_addresses.get(agent_id);
        if addr == Address::ZERO {
            return Err(IdentityError::UnknownAgent(UnknownAgent {}));
        }
        let domain = self.agent_domains.getter(agent_id).get_bytes();
        Ok((agent_id, domain.into(), addr))
    }

    /// Reverse lookup by controlling address. Returns 0 if not registered.
    #[selector(name = "resolveByAddress")]
    pub fn resolve_by_address(&self, agent_address: Address) -> U256 {
        self.address_to_id.get(agent_address)
    }

    /// Reverse lookup by keccak256(domain). Returns 0 if not registered.
    #[selector(name = "resolveByDomainHash")]
    pub fn resolve_by_domain_hash(&self, domain_hash: FixedBytes<32>) -> U256 {
        self.domain_to_id.get(domain_hash)
    }
}
