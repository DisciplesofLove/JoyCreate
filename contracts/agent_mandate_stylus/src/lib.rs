#![cfg_attr(not(any(test, feature = "export-abi")), no_std)]
extern crate alloc;

use alloc::{vec, vec::Vec};

#[cfg(not(any(test, feature = "export-abi")))]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}

use alloy_primitives::{Address, FixedBytes, U256};
use stylus_sdk::{alloy_sol_types::sol, prelude::*};

/// Agent Mandate — on-chain delegation for autonomous JOY agents.
///
/// A `principal` grants a `mandate` to an `agent` key that bounds what the
/// agent may do on its behalf:
///   - `spendLimit`: cumulative spend cap (wei or token base units),
///   - `actionScope`: a keccak256 hash identifying the allowed action set
///     (the "action keys"),
///   - `expiry`: a unix timestamp after which the mandate is invalid
///     (0 = no time limit).
///
/// The agent reports usage via `recordSpend`, which accumulates against the
/// cap. The principal can `revokeMandate` at any time. Off-chain executors
/// (X402 rail, MCP tools) check `isValid` / `canSpend` before acting.
sol_storage! {
    #[entrypoint]
    pub struct AgentMandate {
        // next mandate id to assign (ids start at 1).
        uint256 next_id;
        // mandateId => principal (grantor)
        mapping(uint256 => address) mandate_principals;
        // mandateId => agent (delegated key)
        mapping(uint256 => address) mandate_agents;
        // mandateId => cumulative spend cap
        mapping(uint256 => uint256) mandate_limits;
        // mandateId => spent so far
        mapping(uint256 => uint256) mandate_spent;
        // mandateId => expiry timestamp (0 = none)
        mapping(uint256 => uint256) mandate_expiry;
        // mandateId => action scope hash
        mapping(uint256 => bytes32) mandate_scope;
        // mandateId => active flag
        mapping(uint256 => bool) mandate_active;
        bool initialized;
    }
}

sol! {
    #[derive(Debug)]
    error AlreadyInitialized();
    #[derive(Debug)]
    error ZeroAddress();
    #[derive(Debug)]
    error UnauthorizedCaller();
    #[derive(Debug)]
    error UnknownMandate();
    #[derive(Debug)]
    error MandateInactive();
    #[derive(Debug)]
    error MandateExpired();
    #[derive(Debug)]
    error SpendLimitExceeded();

    /// Emitted when a mandate is granted.
    event MandateCreated(
        uint256 indexed mandateId,
        address indexed principal,
        address indexed agent,
        uint256 spendLimit,
        uint256 expiry,
        bytes32 actionScope
    );

    /// Emitted when the agent records spend against a mandate.
    event MandateSpent(
        uint256 indexed mandateId,
        address indexed agent,
        uint256 amount,
        uint256 totalSpent
    );

    /// Emitted when a mandate is revoked by its principal.
    event MandateRevoked(uint256 indexed mandateId, address indexed principal);
}

#[derive(SolidityError, Debug)]
pub enum MandateError {
    AlreadyInitialized(AlreadyInitialized),
    ZeroAddress(ZeroAddress),
    UnauthorizedCaller(UnauthorizedCaller),
    UnknownMandate(UnknownMandate),
    MandateInactive(MandateInactive),
    MandateExpired(MandateExpired),
    SpendLimitExceeded(SpendLimitExceeded),
}

#[public]
impl AgentMandate {
    /// One-time init. Sets the id counter to start at 1.
    pub fn initialize(&mut self) -> Result<(), MandateError> {
        if self.initialized.get() {
            return Err(MandateError::AlreadyInitialized(AlreadyInitialized {}));
        }
        self.initialized.set(true);
        self.next_id.set(U256::from(1u64));
        Ok(())
    }

    /// Total number of mandates created.
    #[selector(name = "mandateCount")]
    pub fn mandate_count(&self) -> U256 {
        let next = self.next_id.get();
        if next == U256::ZERO {
            U256::ZERO
        } else {
            next - U256::from(1u64)
        }
    }

    /// Grant a new mandate. The caller becomes the principal.
    #[selector(name = "createMandate")]
    pub fn create_mandate(
        &mut self,
        agent: Address,
        spend_limit: U256,
        expiry: U256,
        action_scope: FixedBytes<32>,
    ) -> Result<U256, MandateError> {
        if agent == Address::ZERO {
            return Err(MandateError::ZeroAddress(ZeroAddress {}));
        }
        let principal = self.vm().msg_sender();
        let id = self.next_id.get();
        self.mandate_principals.setter(id).set(principal);
        self.mandate_agents.setter(id).set(agent);
        self.mandate_limits.setter(id).set(spend_limit);
        self.mandate_spent.setter(id).set(U256::ZERO);
        self.mandate_expiry.setter(id).set(expiry);
        self.mandate_scope.setter(id).set(action_scope);
        self.mandate_active.setter(id).set(true);
        self.next_id.set(id + U256::from(1u64));

        log(
            self.vm(),
            MandateCreated {
                mandateId: id,
                principal,
                agent,
                spendLimit: spend_limit,
                expiry,
                actionScope: action_scope,
            },
        );
        Ok(id)
    }

    /// Record spend against a mandate. Only the delegated agent may call.
    /// Reverts if the mandate is inactive, expired, or the cap is exceeded.
    /// Returns the remaining allowance.
    #[selector(name = "recordSpend")]
    pub fn record_spend(
        &mut self,
        mandate_id: U256,
        amount: U256,
    ) -> Result<U256, MandateError> {
        let agent = self.mandate_agents.get(mandate_id);
        if agent == Address::ZERO {
            return Err(MandateError::UnknownMandate(UnknownMandate {}));
        }
        if self.vm().msg_sender() != agent {
            return Err(MandateError::UnauthorizedCaller(UnauthorizedCaller {}));
        }
        if !self.mandate_active.get(mandate_id) {
            return Err(MandateError::MandateInactive(MandateInactive {}));
        }
        let expiry = self.mandate_expiry.get(mandate_id);
        if expiry != U256::ZERO {
            let now = U256::from(self.vm().block_timestamp());
            if now >= expiry {
                return Err(MandateError::MandateExpired(MandateExpired {}));
            }
        }
        let limit = self.mandate_limits.get(mandate_id);
        let spent = self.mandate_spent.get(mandate_id);
        let new_spent = spent + amount;
        if new_spent > limit {
            return Err(MandateError::SpendLimitExceeded(SpendLimitExceeded {}));
        }
        self.mandate_spent.setter(mandate_id).set(new_spent);

        log(
            self.vm(),
            MandateSpent {
                mandateId: mandate_id,
                agent,
                amount,
                totalSpent: new_spent,
            },
        );
        Ok(limit - new_spent)
    }

    /// Revoke a mandate. Only the principal may call.
    #[selector(name = "revokeMandate")]
    pub fn revoke_mandate(&mut self, mandate_id: U256) -> Result<bool, MandateError> {
        let principal = self.mandate_principals.get(mandate_id);
        if principal == Address::ZERO {
            return Err(MandateError::UnknownMandate(UnknownMandate {}));
        }
        if self.vm().msg_sender() != principal {
            return Err(MandateError::UnauthorizedCaller(UnauthorizedCaller {}));
        }
        self.mandate_active.setter(mandate_id).set(false);
        log(
            self.vm(),
            MandateRevoked {
                mandateId: mandate_id,
                principal,
            },
        );
        Ok(true)
    }

    /// Whether a mandate is currently active and not expired.
    #[selector(name = "isValid")]
    pub fn is_valid(&self, mandate_id: U256) -> bool {
        if self.mandate_principals.get(mandate_id) == Address::ZERO {
            return false;
        }
        if !self.mandate_active.get(mandate_id) {
            return false;
        }
        let expiry = self.mandate_expiry.get(mandate_id);
        if expiry != U256::ZERO {
            let now = U256::from(self.vm().block_timestamp());
            if now >= expiry {
                return false;
            }
        }
        true
    }

    /// Whether `amount` can still be spent under a mandate right now.
    #[selector(name = "canSpend")]
    pub fn can_spend(&self, mandate_id: U256, amount: U256) -> bool {
        if !self.is_valid(mandate_id) {
            return false;
        }
        let limit = self.mandate_limits.get(mandate_id);
        let spent = self.mandate_spent.get(mandate_id);
        spent + amount <= limit
    }

    /// Remaining allowance (limit - spent), regardless of validity.
    #[selector(name = "remaining")]
    pub fn remaining(&self, mandate_id: U256) -> U256 {
        let limit = self.mandate_limits.get(mandate_id);
        let spent = self.mandate_spent.get(mandate_id);
        if spent >= limit {
            U256::ZERO
        } else {
            limit - spent
        }
    }

    /// Returns (principal, agent, spendLimit, spent, expiry, actionScope,
    /// active).
    #[selector(name = "getMandate")]
    pub fn get_mandate(
        &self,
        mandate_id: U256,
    ) -> Result<(Address, Address, U256, U256, U256, FixedBytes<32>, bool), MandateError> {
        let principal = self.mandate_principals.get(mandate_id);
        if principal == Address::ZERO {
            return Err(MandateError::UnknownMandate(UnknownMandate {}));
        }
        Ok((
            principal,
            self.mandate_agents.get(mandate_id),
            self.mandate_limits.get(mandate_id),
            self.mandate_spent.get(mandate_id),
            self.mandate_expiry.get(mandate_id),
            self.mandate_scope.get(mandate_id),
            self.mandate_active.get(mandate_id),
        ))
    }
}
