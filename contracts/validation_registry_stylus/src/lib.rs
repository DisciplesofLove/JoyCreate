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

/// ERC-8004 Validation Registry (Trustless Agents).
///
/// A server agent (or its orchestrator) requests independent validation of a
/// piece of work identified by `dataHash` (e.g. the keccak256 of a TEE
/// attestation / inference output). A designated validator later responds
/// with a score in [0, 100]. Both phases emit events for off-chain indexers
/// (8004scan) and downstream gating (EditionController only mints once a
/// validation passes a threshold).
sol_storage! {
    #[entrypoint]
    pub struct ValidationRegistry {
        // dataHash => validator address
        mapping(bytes32 => address) request_validator;
        // dataHash => server agent id
        mapping(bytes32 => uint256) request_server;
        // dataHash => request exists
        mapping(bytes32 => bool) request_exists;
        // dataHash => has response
        mapping(bytes32 => bool) responded;
        // dataHash => response score [0,100]
        mapping(bytes32 => uint256) response_score;
        bool initialized;
    }
}

sol! {
    #[derive(Debug)]
    error AlreadyInitialized();
    #[derive(Debug)]
    error ZeroValidator();
    #[derive(Debug)]
    error ZeroServerId();
    #[derive(Debug)]
    error RequestAlreadyExists();
    #[derive(Debug)]
    error UnknownRequest();
    #[derive(Debug)]
    error NotValidator();
    #[derive(Debug)]
    error AlreadyResponded();
    #[derive(Debug)]
    error ScoreOutOfRange();

    /// A validation was requested for `dataHash`.
    event ValidationRequest(
        bytes32 indexed dataHash,
        address indexed validator,
        uint256 indexed serverAgentId
    );

    /// The validator responded for `dataHash` with a score in [0,100].
    event ValidationResponse(
        bytes32 indexed dataHash,
        address indexed validator,
        uint256 indexed serverAgentId,
        uint256 response
    );
}

#[derive(SolidityError, Debug)]
pub enum ValidationError {
    AlreadyInitialized(AlreadyInitialized),
    ZeroValidator(ZeroValidator),
    ZeroServerId(ZeroServerId),
    RequestAlreadyExists(RequestAlreadyExists),
    UnknownRequest(UnknownRequest),
    NotValidator(NotValidator),
    AlreadyResponded(AlreadyResponded),
    ScoreOutOfRange(ScoreOutOfRange),
}

#[public]
impl ValidationRegistry {
    pub fn initialize(&mut self) -> Result<(), ValidationError> {
        if self.initialized.get() {
            return Err(ValidationError::AlreadyInitialized(AlreadyInitialized {}));
        }
        self.initialized.set(true);
        Ok(())
    }

    /// Request validation of `data_hash` by `validator` for `server_agent_id`.
    #[selector(name = "validationRequest")]
    pub fn validation_request(
        &mut self,
        validator: Address,
        server_agent_id: U256,
        data_hash: FixedBytes<32>,
    ) -> Result<(), ValidationError> {
        if validator == Address::ZERO {
            return Err(ValidationError::ZeroValidator(ZeroValidator {}));
        }
        if server_agent_id == U256::ZERO {
            return Err(ValidationError::ZeroServerId(ZeroServerId {}));
        }
        if self.request_exists.get(data_hash) {
            return Err(ValidationError::RequestAlreadyExists(RequestAlreadyExists {}));
        }
        self.request_validator.setter(data_hash).set(validator);
        self.request_server.setter(data_hash).set(server_agent_id);
        self.request_exists.setter(data_hash).set(true);

        log(
            self.vm(),
            ValidationRequest {
                dataHash: data_hash,
                validator,
                serverAgentId: server_agent_id,
            },
        );
        Ok(())
    }

    /// The designated validator submits a response score in [0,100].
    #[selector(name = "validationResponse")]
    pub fn validation_response(
        &mut self,
        data_hash: FixedBytes<32>,
        response: U256,
    ) -> Result<(), ValidationError> {
        if !self.request_exists.get(data_hash) {
            return Err(ValidationError::UnknownRequest(UnknownRequest {}));
        }
        if self.vm().msg_sender() != self.request_validator.get(data_hash) {
            return Err(ValidationError::NotValidator(NotValidator {}));
        }
        if self.responded.get(data_hash) {
            return Err(ValidationError::AlreadyResponded(AlreadyResponded {}));
        }
        if response > U256::from(100u64) {
            return Err(ValidationError::ScoreOutOfRange(ScoreOutOfRange {}));
        }
        self.responded.setter(data_hash).set(true);
        self.response_score.setter(data_hash).set(response);

        log(
            self.vm(),
            ValidationResponse {
                dataHash: data_hash,
                validator: self.vm().msg_sender(),
                serverAgentId: self.request_server.get(data_hash),
                response,
            },
        );
        Ok(())
    }

    /// Returns (validator, serverAgentId, exists).
    #[selector(name = "getRequest")]
    pub fn get_request(&self, data_hash: FixedBytes<32>) -> (Address, U256, bool) {
        (
            self.request_validator.get(data_hash),
            self.request_server.get(data_hash),
            self.request_exists.get(data_hash),
        )
    }

    /// Returns (responded, score).
    #[selector(name = "getResponse")]
    pub fn get_response(&self, data_hash: FixedBytes<32>) -> (bool, U256) {
        (
            self.responded.get(data_hash),
            self.response_score.get(data_hash),
        )
    }
}
