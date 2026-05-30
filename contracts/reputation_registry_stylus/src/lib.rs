#![cfg_attr(not(any(test, feature = "export-abi")), no_std)]
extern crate alloc;

use alloc::{vec, vec::Vec};

#[cfg(not(any(test, feature = "export-abi")))]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}

use alloy_primitives::{keccak256, FixedBytes, U256};
use stylus_sdk::{alloy_sol_types::sol, prelude::*};

/// ERC-8004 Reputation Registry (Trustless Agents).
///
/// A server agent pre-authorizes a client agent to leave feedback for a
/// completed interaction (`acceptFeedback`). The authorized client then
/// submits a score in [0, 100] exactly once (`submitFeedback`). Aggregate
/// score state (sum + count) is kept on-chain so consumers can compute an
/// average without replaying events; the full feedback payload lives
/// off-chain (IPFS) and is referenced by `feedbackUri`.
///
/// Agent identity is referenced by the `agentId` minted in the
/// IdentityRegistry. This contract does not re-validate ownership; the
/// IdentityRegistry is the source of truth for address<->agentId binding.
sol_storage! {
    #[entrypoint]
    pub struct ReputationRegistry {
        // keccak256(clientId || serverId) => authorized (pending feedback)
        mapping(bytes32 => bool) feedback_auth;
        // serverId => cumulative score sum
        mapping(uint256 => uint256) score_sum;
        // serverId => number of submitted feedbacks
        mapping(uint256 => uint256) score_count;
        bool initialized;
    }
}

sol! {
    #[derive(Debug)]
    error AlreadyInitialized();
    #[derive(Debug)]
    error NotAuthorized();
    #[derive(Debug)]
    error ScoreOutOfRange();
    #[derive(Debug)]
    error ZeroAgentId();

    /// Server agent authorized a client to leave feedback.
    event AuthFeedback(
        uint256 indexed clientId,
        uint256 indexed serverId,
        address authorizedBy
    );

    /// Client submitted feedback for a server agent.
    event FeedbackSubmitted(
        uint256 indexed clientId,
        uint256 indexed serverId,
        uint256 score,
        bytes feedbackUri
    );
}

#[derive(SolidityError, Debug)]
pub enum ReputationError {
    AlreadyInitialized(AlreadyInitialized),
    NotAuthorized(NotAuthorized),
    ScoreOutOfRange(ScoreOutOfRange),
    ZeroAgentId(ZeroAgentId),
}

impl ReputationRegistry {
    fn auth_key(client_id: U256, server_id: U256) -> FixedBytes<32> {
        let mut buf = Vec::with_capacity(64);
        buf.extend_from_slice(&client_id.to_be_bytes::<32>());
        buf.extend_from_slice(&server_id.to_be_bytes::<32>());
        keccak256(&buf)
    }
}

#[public]
impl ReputationRegistry {
    pub fn initialize(&mut self) -> Result<(), ReputationError> {
        if self.initialized.get() {
            return Err(ReputationError::AlreadyInitialized(AlreadyInitialized {}));
        }
        self.initialized.set(true);
        Ok(())
    }

    /// Server agent authorizes `client_id` to leave one feedback for
    /// `server_id`. Idempotent.
    #[selector(name = "acceptFeedback")]
    pub fn accept_feedback(
        &mut self,
        client_id: U256,
        server_id: U256,
    ) -> Result<(), ReputationError> {
        if client_id == U256::ZERO || server_id == U256::ZERO {
            return Err(ReputationError::ZeroAgentId(ZeroAgentId {}));
        }
        let key = Self::auth_key(client_id, server_id);
        self.feedback_auth.setter(key).set(true);
        log(
            self.vm(),
            AuthFeedback {
                clientId: client_id,
                serverId: server_id,
                authorizedBy: self.vm().msg_sender(),
            },
        );
        Ok(())
    }

    /// Authorized client submits a score in [0, 100] for a server agent.
    /// Consumes the authorization (one feedback per authorization).
    #[selector(name = "submitFeedback")]
    pub fn submit_feedback(
        &mut self,
        client_id: U256,
        server_id: U256,
        score: U256,
        feedback_uri: stylus_sdk::abi::Bytes,
    ) -> Result<(), ReputationError> {
        let key = Self::auth_key(client_id, server_id);
        if !self.feedback_auth.get(key) {
            return Err(ReputationError::NotAuthorized(NotAuthorized {}));
        }
        if score > U256::from(100u64) {
            return Err(ReputationError::ScoreOutOfRange(ScoreOutOfRange {}));
        }
        self.feedback_auth.setter(key).set(false);

        let prev_sum = self.score_sum.get(server_id);
        self.score_sum.setter(server_id).set(prev_sum + score);
        let prev_count = self.score_count.get(server_id);
        self.score_count
            .setter(server_id)
            .set(prev_count + U256::from(1u64));

        log(
            self.vm(),
            FeedbackSubmitted {
                clientId: client_id,
                serverId: server_id,
                score,
                feedbackUri: feedback_uri.to_vec().into(),
            },
        );
        Ok(())
    }

    /// Returns whether `client_id` may currently submit feedback for
    /// `server_id`.
    #[selector(name = "isAuthorized")]
    pub fn is_authorized(&self, client_id: U256, server_id: U256) -> bool {
        self.feedback_auth.get(Self::auth_key(client_id, server_id))
    }

    /// Returns (count, sum) of feedback for a server agent.
    #[selector(name = "getScore")]
    pub fn get_score(&self, server_id: U256) -> (U256, U256) {
        (
            self.score_count.get(server_id),
            self.score_sum.get(server_id),
        )
    }

    /// Returns the rounded average score in [0, 100], or 0 when there is no
    /// feedback yet.
    #[selector(name = "averageScore")]
    pub fn average_score(&self, server_id: U256) -> U256 {
        let count = self.score_count.get(server_id);
        if count == U256::ZERO {
            return U256::ZERO;
        }
        self.score_sum.get(server_id) / count
    }
}
