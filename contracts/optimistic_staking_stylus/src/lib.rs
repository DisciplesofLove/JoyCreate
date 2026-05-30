#![cfg_attr(not(any(test, feature = "export-abi")), no_std)]
extern crate alloc;

use alloc::{vec, vec::Vec};

#[cfg(not(any(test, feature = "export-abi")))]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}

use alloy_primitives::{Address, FixedBytes, U256};
use stylus_sdk::{alloy_sol_types::sol, call::RawCall, prelude::*};

/// OptimisticStaking — bonded, challengeable attestations for the
/// verifiable-inference rail (P6 "optimistic" provider).
///
/// A validator stakes an ERC-20 bond (USDC by default) and posts an
/// attestation over an inference `digest`
/// (`keccak256(inputHash ‖ outputHash ‖ modelId)`) together with the
/// off-chain `signer`'s EIP-191 signature and a score in [0,100]. The
/// attestation is accepted OPTIMISTICALLY: it becomes final after a
/// challenge window unless disputed.
///
/// Two fraud paths gate the bond:
///   1. `challengeSignature` — permissionless, fully on-chain proof. The
///      stored signature is run through the ecrecover precompile (0x01); if it
///      does NOT recover to the claimed `signer`, the bond is slashed to the
///      challenger immediately. No challenger bond required (it is provable).
///   2. `openDispute` / `resolveDispute` — content disputes (e.g. the score is
///      fraudulent / the output does not match). A challenger posts an equal
///      bond; a trusted `arbiter` (set at init, intended to be a DAO/multisig
///      on mainnet) resolves who is slashed.
///
/// `finalize` releases a validator's locked bond after the window elapses with
/// no dispute. Slashing is checks-effects-interactions safe: state is updated
/// before any token transfer.
///
/// Staking is ERC-20 based (asset-agnostic; the X402 rail uses USDC) so this
/// contract never custodies native ETH. Validators must `approve` the stake
/// token to this contract before `deposit` / `openDispute`.
sol_interface! {
    interface IErc20 {
        function transfer(address to, uint256 value) external returns (bool);
        function transferFrom(address from, address to, uint256 value) external returns (bool);
    }
}

sol_storage! {
    #[entrypoint]
    pub struct OptimisticStaking {
        address owner;
        address arbiter;
        address stake_token;
        uint256 min_stake;
        uint256 challenge_window; // seconds
        // validator => total bonded balance
        mapping(address => uint256) stake;
        // validator => amount locked behind pending/disputed attestations
        mapping(address => uint256) locked;
        // digest => who submitted (and bonded) the attestation
        mapping(bytes32 => address) att_submitter;
        // digest => claimed off-chain signer of the EIP-191 signature
        mapping(bytes32 => address) att_signer;
        // digest => score [0,100]
        mapping(bytes32 => uint256) att_score;
        // digest => bonded amount
        mapping(bytes32 => uint256) att_bond;
        // digest => finalize-after unix timestamp
        mapping(bytes32 => uint256) att_deadline;
        // digest => status: 0 none, 1 pending, 2 finalized, 3 slashed, 4 disputed
        mapping(bytes32 => uint256) att_status;
        // digest => stored ECDSA signature components over the raw digest
        mapping(bytes32 => bytes32) att_sig_r;
        mapping(bytes32 => bytes32) att_sig_s;
        // digest => recovery id v (27 or 28)
        mapping(bytes32 => uint256) att_sig_v;
        // digest => dispute challenger
        mapping(bytes32 => address) att_challenger;
        // digest => challenger's posted bond
        mapping(bytes32 => uint256) att_challenge_bond;
        bool initialized;
    }
}

sol! {
    error AlreadyInitialized();
    error NotOwner();
    error NotArbiter();
    error ZeroAddress();
    error InvalidAmount();
    error InsufficientFreeStake();
    error WrongStatus();
    error WindowNotElapsed();
    error SignatureValid();
    error TransferFailed();

    /// Validator deposited / withdrew ERC-20 stake.
    event StakeChanged(address indexed validator, uint256 newStake, uint256 locked);

    /// A bonded attestation was posted for `digest`.
    event AttestationSubmitted(
        bytes32 indexed digest,
        address indexed submitter,
        address indexed signer,
        uint256 score,
        uint256 bond,
        uint256 deadline
    );

    /// The bond was slashed (bad signature or lost dispute). `to` receives it.
    event Slashed(
        bytes32 indexed digest,
        address indexed submitter,
        address indexed to,
        uint256 amount,
        uint256 reason // 1 = bad signature, 2 = lost dispute
    );

    /// A content dispute was opened against `digest`.
    event DisputeOpened(bytes32 indexed digest, address indexed challenger, uint256 bond);

    /// The arbiter resolved a dispute. `validatorSlashed` indicates the outcome.
    event DisputeResolved(bytes32 indexed digest, bool validatorSlashed);

    /// A pending attestation passed its window unchallenged and is now final.
    event Finalized(bytes32 indexed digest, address indexed submitter, uint256 score);
}

#[derive(SolidityError)]
pub enum StakingError {
    AlreadyInitialized(AlreadyInitialized),
    NotOwner(NotOwner),
    NotArbiter(NotArbiter),
    ZeroAddress(ZeroAddress),
    InvalidAmount(InvalidAmount),
    InsufficientFreeStake(InsufficientFreeStake),
    WrongStatus(WrongStatus),
    WindowNotElapsed(WindowNotElapsed),
    SignatureValid(SignatureValid),
    TransferFailed(TransferFailed),
}

// Attestation lifecycle status codes.
const STATUS_NONE: u64 = 0;
const STATUS_PENDING: u64 = 1;
const STATUS_FINALIZED: u64 = 2;
const STATUS_SLASHED: u64 = 3;
const STATUS_DISPUTED: u64 = 4;

// Slash reason codes.
const REASON_BAD_SIGNATURE: u64 = 1;
const REASON_LOST_DISPUTE: u64 = 2;

#[public]
impl OptimisticStaking {
    /// One-time init. Caller becomes owner. `arbiter` resolves content
    /// disputes (use a DAO/multisig on mainnet). `min_stake` is the minimum
    /// bond per attestation; `challenge_window` is the dispute period seconds.
    pub fn initialize(
        &mut self,
        stake_token: Address,
        arbiter: Address,
        min_stake: U256,
        challenge_window: U256,
    ) -> Result<(), StakingError> {
        if self.initialized.get() {
            return Err(StakingError::AlreadyInitialized(AlreadyInitialized {}));
        }
        if stake_token == Address::ZERO || arbiter == Address::ZERO {
            return Err(StakingError::ZeroAddress(ZeroAddress {}));
        }
        self.initialized.set(true);
        self.owner.set(self.vm().msg_sender());
        self.stake_token.set(stake_token);
        self.arbiter.set(arbiter);
        self.min_stake.set(min_stake);
        self.challenge_window.set(challenge_window);
        Ok(())
    }

    /// Update dispute arbiter and economic parameters. Owner only.
    #[selector(name = "setParams")]
    pub fn set_params(
        &mut self,
        arbiter: Address,
        min_stake: U256,
        challenge_window: U256,
    ) -> Result<(), StakingError> {
        self.require_owner()?;
        if arbiter == Address::ZERO {
            return Err(StakingError::ZeroAddress(ZeroAddress {}));
        }
        self.arbiter.set(arbiter);
        self.min_stake.set(min_stake);
        self.challenge_window.set(challenge_window);
        Ok(())
    }

    /// Deposit ERC-20 stake (caller must `approve` this contract first).
    #[selector(name = "deposit")]
    pub fn deposit(&mut self, amount: U256) -> Result<(), StakingError> {
        if amount == U256::ZERO {
            return Err(StakingError::InvalidAmount(InvalidAmount {}));
        }
        let from = self.vm().msg_sender();
        let self_addr = self.vm().contract_address();
        let token = IErc20::new(self.stake_token.get());
        token
            .transfer_from(&mut *self, from, self_addr, amount)
            .map_err(|_| StakingError::TransferFailed(TransferFailed {}))?;
        let new_stake = self.stake.get(from) + amount;
        self.stake.setter(from).set(new_stake);
        log(
            self.vm(),
            StakeChanged {
                validator: from,
                newStake: new_stake,
                locked: self.locked.get(from),
            },
        );
        Ok(())
    }

    /// Withdraw FREE (unlocked) stake back to the caller.
    #[selector(name = "withdraw")]
    pub fn withdraw(&mut self, amount: U256) -> Result<(), StakingError> {
        if amount == U256::ZERO {
            return Err(StakingError::InvalidAmount(InvalidAmount {}));
        }
        let who = self.vm().msg_sender();
        let free = self.stake.get(who) - self.locked.get(who);
        if amount > free {
            return Err(StakingError::InsufficientFreeStake(InsufficientFreeStake {}));
        }
        // Effects before interaction.
        let new_stake = self.stake.get(who) - amount;
        self.stake.setter(who).set(new_stake);
        let token = IErc20::new(self.stake_token.get());
        token
            .transfer(&mut *self, who, amount)
            .map_err(|_| StakingError::TransferFailed(TransferFailed {}))?;
        log(
            self.vm(),
            StakeChanged {
                validator: who,
                newStake: new_stake,
                locked: self.locked.get(who),
            },
        );
        Ok(())
    }

    /// Post a bonded, signed attestation for `digest`. The caller (relayer)
    /// bonds from their free stake; `signer` is the off-chain identity that
    /// produced `signature` (EIP-191 over `digest`). Accepted optimistically.
    #[selector(name = "submitAttestation")]
    pub fn submit_attestation(
        &mut self,
        digest: FixedBytes<32>,
        signer: Address,
        score: U256,
        bond: U256,
        r: FixedBytes<32>,
        s: FixedBytes<32>,
        v: u8,
    ) -> Result<(), StakingError> {
        if signer == Address::ZERO {
            return Err(StakingError::ZeroAddress(ZeroAddress {}));
        }
        if score > U256::from(100u64) {
            return Err(StakingError::InvalidAmount(InvalidAmount {}));
        }
        let vn = if v < 27 { v + 27 } else { v };
        if vn != 27 && vn != 28 {
            return Err(StakingError::InvalidAmount(InvalidAmount {}));
        }
        if self.att_status.get(digest) != U256::from(STATUS_NONE) {
            return Err(StakingError::WrongStatus(WrongStatus {}));
        }
        if bond < self.min_stake.get() {
            return Err(StakingError::InvalidAmount(InvalidAmount {}));
        }
        let submitter = self.vm().msg_sender();
        let free = self.stake.get(submitter) - self.locked.get(submitter);
        if bond > free {
            return Err(StakingError::InsufficientFreeStake(InsufficientFreeStake {}));
        }

        let new_locked = self.locked.get(submitter) + bond;
        self.locked.setter(submitter).set(new_locked);

        let deadline = U256::from(self.vm().block_timestamp()) + self.challenge_window.get();
        self.att_submitter.setter(digest).set(submitter);
        self.att_signer.setter(digest).set(signer);
        self.att_score.setter(digest).set(score);
        self.att_bond.setter(digest).set(bond);
        self.att_deadline.setter(digest).set(deadline);
        self.att_status
            .setter(digest)
            .set(U256::from(STATUS_PENDING));
        self.att_sig_r.setter(digest).set(r);
        self.att_sig_s.setter(digest).set(s);
        self.att_sig_v.setter(digest).set(U256::from(vn));

        log(
            self.vm(),
            AttestationSubmitted {
                digest,
                submitter,
                signer,
                score,
                bond,
                deadline,
            },
        );
        Ok(())
    }

    /// Permissionless fraud proof: if the stored signature does NOT recover to
    /// the claimed `signer`, slash the bond to the caller. Reverts if the
    /// signature is in fact valid.
    #[selector(name = "challengeSignature")]
    pub fn challenge_signature(&mut self, digest: FixedBytes<32>) -> Result<(), StakingError> {
        if self.att_status.get(digest) != U256::from(STATUS_PENDING) {
            return Err(StakingError::WrongStatus(WrongStatus {}));
        }
        let claimed = self.att_signer.get(digest);
        let r = self.att_sig_r.get(digest);
        let s = self.att_sig_s.get(digest);
        let v = self.att_sig_v.get(digest).byte(0);
        let recovered = self.ecrecover_raw(digest, r, s, v);
        if recovered == Some(claimed) {
            // Signature is valid — challenge is unfounded.
            return Err(StakingError::SignatureValid(SignatureValid {}));
        }
        let challenger = self.vm().msg_sender();
        self.slash_to(digest, challenger, REASON_BAD_SIGNATURE)
    }

    /// Open a content dispute against a pending attestation. The challenger
    /// posts a bond equal to the validator's bond (must `approve` first). The
    /// dispute must be opened before the challenge window elapses.
    #[selector(name = "openDispute")]
    pub fn open_dispute(&mut self, digest: FixedBytes<32>) -> Result<(), StakingError> {
        if self.att_status.get(digest) != U256::from(STATUS_PENDING) {
            return Err(StakingError::WrongStatus(WrongStatus {}));
        }
        if U256::from(self.vm().block_timestamp()) >= self.att_deadline.get(digest) {
            return Err(StakingError::WrongStatus(WrongStatus {}));
        }
        let bond = self.att_bond.get(digest);
        let challenger = self.vm().msg_sender();
        let self_addr = self.vm().contract_address();
        let token = IErc20::new(self.stake_token.get());
        token
            .transfer_from(&mut *self, challenger, self_addr, bond)
            .map_err(|_| StakingError::TransferFailed(TransferFailed {}))?;

        self.att_challenger.setter(digest).set(challenger);
        self.att_challenge_bond.setter(digest).set(bond);
        self.att_status
            .setter(digest)
            .set(U256::from(STATUS_DISPUTED));
        log(self.vm(), DisputeOpened { digest, challenger, bond });
        Ok(())
    }

    /// Arbiter resolves a content dispute.
    ///   - `validator_slashed = true`: the attestation was bad. The validator
    ///     bond is slashed and the challenger receives bond + their returned
    ///     challenge bond.
    ///   - `validator_slashed = false`: the attestation stands. The validator's
    ///     bond is unlocked and the challenger's bond is transferred to the
    ///     validator as compensation.
    #[selector(name = "resolveDispute")]
    pub fn resolve_dispute(
        &mut self,
        digest: FixedBytes<32>,
        validator_slashed: bool,
    ) -> Result<(), StakingError> {
        self.require_arbiter()?;
        if self.att_status.get(digest) != U256::from(STATUS_DISPUTED) {
            return Err(StakingError::WrongStatus(WrongStatus {}));
        }
        let submitter = self.att_submitter.get(digest);
        let challenger = self.att_challenger.get(digest);
        let bond = self.att_bond.get(digest);
        let challenge_bond = self.att_challenge_bond.get(digest);
        let token = IErc20::new(self.stake_token.get());

        if validator_slashed {
            // Effects: remove the validator's locked bond from their balance.
            let new_locked = self.locked.get(submitter) - bond;
            self.locked.setter(submitter).set(new_locked);
            let new_stake = self.stake.get(submitter) - bond;
            self.stake.setter(submitter).set(new_stake);
            self.att_status
                .setter(digest)
                .set(U256::from(STATUS_SLASHED));
            // Interaction: pay challenger their returned bond + the slashed bond.
            token
                .transfer(&mut *self, challenger, bond + challenge_bond)
                .map_err(|_| StakingError::TransferFailed(TransferFailed {}))?;
            log(
                self.vm(),
                Slashed {
                    digest,
                    submitter,
                    to: challenger,
                    amount: bond,
                    reason: U256::from(REASON_LOST_DISPUTE),
                },
            );
        } else {
            // Validator wins: unlock their bond, hand them the challenge bond.
            let new_locked = self.locked.get(submitter) - bond;
            self.locked.setter(submitter).set(new_locked);
            self.att_status
                .setter(digest)
                .set(U256::from(STATUS_FINALIZED));
            token
                .transfer(&mut *self, submitter, challenge_bond)
                .map_err(|_| StakingError::TransferFailed(TransferFailed {}))?;
        }
        log(self.vm(), DisputeResolved { digest, validatorSlashed: validator_slashed });
        Ok(())
    }

    /// Finalize a pending attestation after its challenge window elapses with
    /// no dispute. Releases the validator's locked bond. Permissionless.
    #[selector(name = "finalize")]
    pub fn finalize(&mut self, digest: FixedBytes<32>) -> Result<(), StakingError> {
        if self.att_status.get(digest) != U256::from(STATUS_PENDING) {
            return Err(StakingError::WrongStatus(WrongStatus {}));
        }
        if U256::from(self.vm().block_timestamp()) < self.att_deadline.get(digest) {
            return Err(StakingError::WindowNotElapsed(WindowNotElapsed {}));
        }
        let submitter = self.att_submitter.get(digest);
        let bond = self.att_bond.get(digest);
        let new_locked = self.locked.get(submitter) - bond;
        self.locked.setter(submitter).set(new_locked);
        self.att_status
            .setter(digest)
            .set(U256::from(STATUS_FINALIZED));
        log(
            self.vm(),
            Finalized {
                digest,
                submitter,
                score: self.att_score.get(digest),
            },
        );
        Ok(())
    }

    // --- views -----------------------------------------------------------

    /// Returns (submitter, signer, score, bond, deadline, status).
    #[selector(name = "getAttestation")]
    pub fn get_attestation(
        &self,
        digest: FixedBytes<32>,
    ) -> (Address, Address, U256, U256, U256, U256) {
        (
            self.att_submitter.get(digest),
            self.att_signer.get(digest),
            self.att_score.get(digest),
            self.att_bond.get(digest),
            self.att_deadline.get(digest),
            self.att_status.get(digest),
        )
    }

    /// Returns (totalStake, locked) for a validator.
    #[selector(name = "stakeOf")]
    pub fn stake_of(&self, validator: Address) -> (U256, U256) {
        (self.stake.get(validator), self.locked.get(validator))
    }

    /// Returns (owner, arbiter, stakeToken, minStake, challengeWindow).
    #[selector(name = "getConfig")]
    pub fn get_config(&self) -> (Address, Address, Address, U256, U256) {
        (
            self.owner.get(),
            self.arbiter.get(),
            self.stake_token.get(),
            self.min_stake.get(),
            self.challenge_window.get(),
        )
    }
}

impl OptimisticStaking {
    fn require_owner(&self) -> Result<(), StakingError> {
        if self.vm().msg_sender() != self.owner.get() {
            return Err(StakingError::NotOwner(NotOwner {}));
        }
        Ok(())
    }

    fn require_arbiter(&self) -> Result<(), StakingError> {
        if self.vm().msg_sender() != self.arbiter.get() {
            return Err(StakingError::NotArbiter(NotArbiter {}));
        }
        Ok(())
    }

    /// Slash a pending attestation's bond to `to`, marking it slashed.
    /// Checks-effects-interactions: state is updated before the transfer.
    fn slash_to(
        &mut self,
        digest: FixedBytes<32>,
        to: Address,
        reason: u64,
    ) -> Result<(), StakingError> {
        let submitter = self.att_submitter.get(digest);
        let bond = self.att_bond.get(digest);
        let new_locked = self.locked.get(submitter) - bond;
        self.locked.setter(submitter).set(new_locked);
        let new_stake = self.stake.get(submitter) - bond;
        self.stake.setter(submitter).set(new_stake);
        self.att_status
            .setter(digest)
            .set(U256::from(STATUS_SLASHED));
        let token = IErc20::new(self.stake_token.get());
        token
            .transfer(&mut *self, to, bond)
            .map_err(|_| StakingError::TransferFailed(TransferFailed {}))?;
        log(
            self.vm(),
            Slashed {
                digest,
                submitter,
                to,
                amount: bond,
                reason: U256::from(reason),
            },
        );
        Ok(())
    }

    /// Recover the signer over the RAW 32-byte `digest` (no EIP-191 prefix —
    /// `digest` is already a keccak hash) via the 0x01 precompile. Returns
    /// None on malformed input / failed recovery.
    fn ecrecover_raw(
        &self,
        digest: FixedBytes<32>,
        r: FixedBytes<32>,
        s: FixedBytes<32>,
        v: u8,
    ) -> Option<Address> {
        if v != 27 && v != 28 {
            return None;
        }

        // ecrecover precompile input: hash(32) ‖ v(32, right-aligned) ‖ r(32) ‖ s(32)
        let mut input = [0u8; 128];
        input[0..32].copy_from_slice(digest.as_slice());
        input[63] = v;
        input[64..96].copy_from_slice(r.as_slice());
        input[96..128].copy_from_slice(s.as_slice());

        let out = unsafe {
            RawCall::new_static()
                .call(Address::with_last_byte(1), &input)
                .ok()?
        };
        if out.len() != 32 {
            return None;
        }
        // Failed recovery returns 32 zero bytes.
        if out.iter().all(|b| *b == 0) {
            return None;
        }
        Some(Address::from_slice(&out[12..32]))
    }
}
