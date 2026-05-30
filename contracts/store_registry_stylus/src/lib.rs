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

/// Store Registry — the JOY Marketplace storefront directory.
///
/// Each store is assigned a monotonically increasing `storeId` (starting at
/// 1) and is bound to:
///   - `owner`: the account that controls the store,
///   - `agentId`: the ERC-8004 identity that represents the store as a
///     trustless agent,
///   - `slug`: a human-readable handle (raw bytes; Stylus `sol_storage!`
///     does not support `string`).
///
/// Reverse resolution is provided by the keccak256 hash of the slug, letting
/// hierarchical ENS / 8004scan map `*.store.marketplace.eth` labels back to a
/// `storeId`.
sol_storage! {
    #[entrypoint]
    pub struct StoreRegistry {
        // next id to assign (ids start at 1).
        uint256 next_id;
        // storeId => owner
        mapping(uint256 => address) store_owners;
        // storeId => ERC-8004 agentId
        mapping(uint256 => uint256) store_agents;
        // storeId => slug bytes
        mapping(uint256 => bytes) store_slugs;
        // keccak256(slug) => storeId (reverse lookup; 0 = none)
        mapping(bytes32 => uint256) slug_to_id;
        bool initialized;
    }
}

sol! {
    #[derive(Debug)]
    error AlreadyInitialized();
    #[derive(Debug)]
    error EmptySlug();
    #[derive(Debug)]
    error ZeroAddress();
    #[derive(Debug)]
    error UnauthorizedCaller();
    #[derive(Debug)]
    error UnknownStore();
    #[derive(Debug)]
    error SlugAlreadyRegistered();

    /// Emitted when a new store is registered.
    event StoreRegistered(
        uint256 indexed storeId,
        address indexed owner,
        uint256 indexed agentId,
        bytes32 slugHash,
        bytes slug
    );

    /// Emitted when a store's bound agent changes.
    event StoreAgentUpdated(
        uint256 indexed storeId,
        address indexed owner,
        uint256 indexed agentId
    );

    /// Emitted when store ownership is transferred.
    event StoreTransferred(
        uint256 indexed storeId,
        address indexed from,
        address indexed to
    );
}

#[derive(SolidityError, Debug)]
pub enum StoreError {
    AlreadyInitialized(AlreadyInitialized),
    EmptySlug(EmptySlug),
    ZeroAddress(ZeroAddress),
    UnauthorizedCaller(UnauthorizedCaller),
    UnknownStore(UnknownStore),
    SlugAlreadyRegistered(SlugAlreadyRegistered),
}

#[public]
impl StoreRegistry {
    /// One-time init. Sets the id counter to start at 1.
    pub fn initialize(&mut self) -> Result<(), StoreError> {
        if self.initialized.get() {
            return Err(StoreError::AlreadyInitialized(AlreadyInitialized {}));
        }
        self.initialized.set(true);
        self.next_id.set(U256::from(1u64));
        Ok(())
    }

    /// Total number of registered stores.
    #[selector(name = "storeCount")]
    pub fn store_count(&self) -> U256 {
        let next = self.next_id.get();
        if next == U256::ZERO {
            U256::ZERO
        } else {
            next - U256::from(1u64)
        }
    }

    /// Register a new store. The caller becomes the owner. `agent_id` links
    /// the store to its ERC-8004 identity (may be 0 if not yet registered).
    #[selector(name = "registerStore")]
    pub fn register_store(
        &mut self,
        slug: Bytes,
        agent_id: U256,
    ) -> Result<U256, StoreError> {
        if slug.is_empty() {
            return Err(StoreError::EmptySlug(EmptySlug {}));
        }
        let slug_hash = keccak256(slug.as_slice());
        if self.slug_to_id.get(slug_hash) != U256::ZERO {
            return Err(StoreError::SlugAlreadyRegistered(SlugAlreadyRegistered {}));
        }

        let owner = self.vm().msg_sender();
        let id = self.next_id.get();
        self.store_owners.setter(id).set(owner);
        self.store_agents.setter(id).set(agent_id);
        self.store_slugs.setter(id).set_bytes(slug.as_slice());
        self.slug_to_id.setter(slug_hash).set(id);
        self.next_id.set(id + U256::from(1u64));

        log(
            self.vm(),
            StoreRegistered {
                storeId: id,
                owner,
                agentId: agent_id,
                slugHash: slug_hash,
                slug: slug.to_vec().into(),
            },
        );
        Ok(id)
    }

    /// Update the ERC-8004 agent bound to a store. Only the owner may call.
    #[selector(name = "setAgent")]
    pub fn set_agent(&mut self, store_id: U256, agent_id: U256) -> Result<bool, StoreError> {
        let owner = self.store_owners.get(store_id);
        if owner == Address::ZERO {
            return Err(StoreError::UnknownStore(UnknownStore {}));
        }
        if self.vm().msg_sender() != owner {
            return Err(StoreError::UnauthorizedCaller(UnauthorizedCaller {}));
        }
        self.store_agents.setter(store_id).set(agent_id);
        log(
            self.vm(),
            StoreAgentUpdated {
                storeId: store_id,
                owner,
                agentId: agent_id,
            },
        );
        Ok(true)
    }

    /// Transfer store ownership. Only the current owner may call.
    #[selector(name = "transferStore")]
    pub fn transfer_store(
        &mut self,
        store_id: U256,
        new_owner: Address,
    ) -> Result<bool, StoreError> {
        let owner = self.store_owners.get(store_id);
        if owner == Address::ZERO {
            return Err(StoreError::UnknownStore(UnknownStore {}));
        }
        if self.vm().msg_sender() != owner {
            return Err(StoreError::UnauthorizedCaller(UnauthorizedCaller {}));
        }
        if new_owner == Address::ZERO {
            return Err(StoreError::ZeroAddress(ZeroAddress {}));
        }
        self.store_owners.setter(store_id).set(new_owner);
        log(
            self.vm(),
            StoreTransferred {
                storeId: store_id,
                from: owner,
                to: new_owner,
            },
        );
        Ok(true)
    }

    /// Returns (storeId, owner, agentId, slug).
    #[selector(name = "getStore")]
    pub fn get_store(
        &self,
        store_id: U256,
    ) -> Result<(U256, Address, U256, Bytes), StoreError> {
        let owner = self.store_owners.get(store_id);
        if owner == Address::ZERO {
            return Err(StoreError::UnknownStore(UnknownStore {}));
        }
        let agent_id = self.store_agents.get(store_id);
        let slug = self.store_slugs.getter(store_id).get_bytes();
        Ok((store_id, owner, agent_id, slug.into()))
    }

    /// Reverse lookup by keccak256(slug). Returns 0 if not registered.
    #[selector(name = "resolveBySlugHash")]
    pub fn resolve_by_slug_hash(&self, slug_hash: FixedBytes<32>) -> U256 {
        self.slug_to_id.get(slug_hash)
    }
}
