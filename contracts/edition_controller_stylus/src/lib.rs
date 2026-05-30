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

/// Edition Controller — the drop factory + mint entrypoint for the JOY
/// Marketplace.
///
/// A creator registers a "drop" bound to a `storeId` and an `assetLeaf` (the
/// merkle root of the IPLD provenance shard). Each drop carries:
///   - `price`: the listed price in wei (informational — settlement happens
///     off-chain through the X402 pay-per-prompt rail),
///   - `maxSupply`: optional hard cap (0 = unlimited),
///   - `requiresProof`: when set, an account can only mint after the creator
///     grants it a Proof-of-Use (PoU) credit.
///
/// Minting is gas-only here; it records ownership and emits `Minted` so the
/// 8004scan indexer and downstream EditionController consumers can track the
/// edition. Each mint assigns a globally unique `tokenId`.
sol_storage! {
    #[entrypoint]
    pub struct EditionController {
        address owner;
        // next drop id to assign (ids start at 1).
        uint256 next_drop;
        // next token id to assign (ids start at 1).
        uint256 next_token;
        // dropId => creator
        mapping(uint256 => address) drop_creators;
        // dropId => storeId
        mapping(uint256 => uint256) drop_stores;
        // dropId => asset leaf (provenance merkle root)
        mapping(uint256 => bytes32) drop_leaves;
        // dropId => listed price (wei, informational)
        mapping(uint256 => uint256) drop_prices;
        // dropId => max supply (0 = unlimited)
        mapping(uint256 => uint256) drop_max_supply;
        // dropId => minted count
        mapping(uint256 => uint256) drop_minted;
        // dropId => active flag
        mapping(uint256 => bool) drop_active;
        // dropId => requires PoU proof to mint
        mapping(uint256 => bool) drop_requires_proof;
        // dropId => (account => PoU granted)
        mapping(uint256 => mapping(address => bool)) proof_granted;
        // dropId => (account => minted balance)
        mapping(uint256 => mapping(address => uint256)) balances;
        bool initialized;
    }
}

sol! {
    #[derive(Debug)]
    error AlreadyInitialized();
    #[derive(Debug)]
    error UnauthorizedCaller();
    #[derive(Debug)]
    error UnknownDrop();
    #[derive(Debug)]
    error DropInactive();
    #[derive(Debug)]
    error SupplyExhausted();
    #[derive(Debug)]
    error ProofRequired();

    /// Emitted when a new drop is registered.
    event DropCreated(
        uint256 indexed dropId,
        address indexed creator,
        uint256 indexed storeId,
        bytes32 assetLeaf,
        uint256 price,
        uint256 maxSupply,
        bool requiresProof
    );

    /// Emitted when a drop's active flag changes.
    event DropActivated(uint256 indexed dropId, bool active);

    /// Emitted when a creator grants a Proof-of-Use credit.
    event ProofGranted(uint256 indexed dropId, address indexed account);

    /// Emitted on each mint.
    event Minted(
        uint256 indexed dropId,
        uint256 indexed tokenId,
        address indexed to,
        uint256 price
    );
}

#[derive(SolidityError, Debug)]
pub enum EditionError {
    AlreadyInitialized(AlreadyInitialized),
    UnauthorizedCaller(UnauthorizedCaller),
    UnknownDrop(UnknownDrop),
    DropInactive(DropInactive),
    SupplyExhausted(SupplyExhausted),
    ProofRequired(ProofRequired),
}

#[public]
impl EditionController {
    /// One-time init. Sets the caller as owner and starts both counters at 1.
    pub fn initialize(&mut self) -> Result<(), EditionError> {
        if self.initialized.get() {
            return Err(EditionError::AlreadyInitialized(AlreadyInitialized {}));
        }
        self.initialized.set(true);
        self.owner.set(self.vm().msg_sender());
        self.next_drop.set(U256::from(1u64));
        self.next_token.set(U256::from(1u64));
        Ok(())
    }

    /// Contract owner (deployer / admin).
    #[selector(name = "owner")]
    pub fn owner(&self) -> Address {
        self.owner.get()
    }

    /// Total number of drops created.
    #[selector(name = "dropCount")]
    pub fn drop_count(&self) -> U256 {
        let next = self.next_drop.get();
        if next == U256::ZERO {
            U256::ZERO
        } else {
            next - U256::from(1u64)
        }
    }

    /// Total number of tokens minted across all drops.
    #[selector(name = "totalMinted")]
    pub fn total_minted(&self) -> U256 {
        let next = self.next_token.get();
        if next == U256::ZERO {
            U256::ZERO
        } else {
            next - U256::from(1u64)
        }
    }

    /// Register a new drop. The caller becomes the creator. Drops are created
    /// inactive; call `setActive` to open minting.
    #[selector(name = "createDrop")]
    pub fn create_drop(
        &mut self,
        store_id: U256,
        asset_leaf: FixedBytes<32>,
        price: U256,
        max_supply: U256,
        requires_proof: bool,
    ) -> Result<U256, EditionError> {
        let creator = self.vm().msg_sender();
        let id = self.next_drop.get();
        self.drop_creators.setter(id).set(creator);
        self.drop_stores.setter(id).set(store_id);
        self.drop_leaves.setter(id).set(asset_leaf);
        self.drop_prices.setter(id).set(price);
        self.drop_max_supply.setter(id).set(max_supply);
        self.drop_minted.setter(id).set(U256::ZERO);
        self.drop_active.setter(id).set(false);
        self.drop_requires_proof.setter(id).set(requires_proof);
        self.next_drop.set(id + U256::from(1u64));

        log(
            self.vm(),
            DropCreated {
                dropId: id,
                creator,
                storeId: store_id,
                assetLeaf: asset_leaf,
                price,
                maxSupply: max_supply,
                requiresProof: requires_proof,
            },
        );
        Ok(id)
    }

    /// Toggle a drop's mint availability. Only the creator may call.
    #[selector(name = "setActive")]
    pub fn set_active(&mut self, drop_id: U256, active: bool) -> Result<bool, EditionError> {
        self.require_creator(drop_id)?;
        self.drop_active.setter(drop_id).set(active);
        log(self.vm(), DropActivated { dropId: drop_id, active });
        Ok(true)
    }

    /// Grant a Proof-of-Use credit to an account for a gated drop. Only the
    /// creator may call.
    #[selector(name = "grantProof")]
    pub fn grant_proof(
        &mut self,
        drop_id: U256,
        account: Address,
    ) -> Result<bool, EditionError> {
        self.require_creator(drop_id)?;
        self.proof_granted.setter(drop_id).setter(account).set(true);
        log(
            self.vm(),
            ProofGranted {
                dropId: drop_id,
                account,
            },
        );
        Ok(true)
    }

    /// Mint one token from a drop to the caller. Enforces active state, supply
    /// cap and the PoU gate (consuming the proof credit when present).
    /// Returns the newly assigned `tokenId`.
    #[selector(name = "mint")]
    pub fn mint(&mut self, drop_id: U256) -> Result<U256, EditionError> {
        let creator = self.drop_creators.get(drop_id);
        if creator == Address::ZERO {
            return Err(EditionError::UnknownDrop(UnknownDrop {}));
        }
        if !self.drop_active.get(drop_id) {
            return Err(EditionError::DropInactive(DropInactive {}));
        }
        let max_supply = self.drop_max_supply.get(drop_id);
        let minted = self.drop_minted.get(drop_id);
        if max_supply != U256::ZERO && minted >= max_supply {
            return Err(EditionError::SupplyExhausted(SupplyExhausted {}));
        }

        let to = self.vm().msg_sender();
        if self.drop_requires_proof.get(drop_id) {
            if !self.proof_granted.getter(drop_id).get(to) {
                return Err(EditionError::ProofRequired(ProofRequired {}));
            }
            // Consume the one-shot PoU credit.
            self.proof_granted.setter(drop_id).setter(to).set(false);
        }

        let token_id = self.next_token.get();
        self.next_token.set(token_id + U256::from(1u64));
        self.drop_minted.setter(drop_id).set(minted + U256::from(1u64));
        let bal = self.balances.getter(drop_id).get(to);
        self.balances.setter(drop_id).setter(to).set(bal + U256::from(1u64));

        let price = self.drop_prices.get(drop_id);
        log(
            self.vm(),
            Minted {
                dropId: drop_id,
                tokenId: token_id,
                to,
                price,
            },
        );
        Ok(token_id)
    }

    /// Returns (creator, storeId, assetLeaf, price, maxSupply, minted, active,
    /// requiresProof).
    #[selector(name = "getDrop")]
    pub fn get_drop(
        &self,
        drop_id: U256,
    ) -> Result<(Address, U256, FixedBytes<32>, U256, U256, U256, bool, bool), EditionError> {
        let creator = self.drop_creators.get(drop_id);
        if creator == Address::ZERO {
            return Err(EditionError::UnknownDrop(UnknownDrop {}));
        }
        Ok((
            creator,
            self.drop_stores.get(drop_id),
            self.drop_leaves.get(drop_id),
            self.drop_prices.get(drop_id),
            self.drop_max_supply.get(drop_id),
            self.drop_minted.get(drop_id),
            self.drop_active.get(drop_id),
            self.drop_requires_proof.get(drop_id),
        ))
    }

    /// Minted balance of `account` within a drop.
    #[selector(name = "balanceOf")]
    pub fn balance_of(&self, drop_id: U256, account: Address) -> U256 {
        self.balances.getter(drop_id).get(account)
    }

    /// Whether `account` currently holds a PoU credit for a drop.
    #[selector(name = "isProofGranted")]
    pub fn is_proof_granted(&self, drop_id: U256, account: Address) -> bool {
        self.proof_granted.getter(drop_id).get(account)
    }
}

impl EditionController {
    /// Internal: assert the caller is the creator of an existing drop.
    fn require_creator(&self, drop_id: U256) -> Result<(), EditionError> {
        let creator = self.drop_creators.get(drop_id);
        if creator == Address::ZERO {
            return Err(EditionError::UnknownDrop(UnknownDrop {}));
        }
        if self.vm().msg_sender() != creator {
            return Err(EditionError::UnauthorizedCaller(UnauthorizedCaller {}));
        }
        Ok(())
    }
}
