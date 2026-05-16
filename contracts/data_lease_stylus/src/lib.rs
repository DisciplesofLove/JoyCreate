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

/// DataLease — smart-lease exchange for provenance tokens.
///
/// Creators publish listings tied to a provenance tokenId (issued by the
/// DataProvenance contract). Each listing carries:
///   - price per lease (in wei),
///   - lease duration in seconds,
///   - an Access Control Conditions hash (`accConditionsHash`) — the
///     digest of the Lit Protocol ACCs that gate the encrypted payload.
///
/// When a lab calls `purchaseLease`, the contract:
///   1. Takes msg.value >= price,
///   2. Pays the creator immediately (90%) and the protocol fee wallet (10%),
///   3. Emits `LeaseGranted` with `lessee`, `expiresAt`, `accConditionsHash`.
///
/// An off-chain Lit-Protocol relayer listens for `LeaseGranted` and
/// provisions a time-bound decryption key to `lessee`. No perpetual access;
/// no data export beyond the negotiated window.
sol_storage! {
    #[entrypoint]
    pub struct DataLease {
        // Listing storage
        uint256 next_listing_id;
        mapping(uint256 => address) listing_creator;
        mapping(uint256 => uint256) listing_token_id;
        mapping(uint256 => uint256) listing_price_wei;
        mapping(uint256 => uint256) listing_duration_secs;
        mapping(uint256 => bytes32) listing_acc_hash;
        mapping(uint256 => bool)    listing_active;

        // Lease storage
        uint256 next_lease_id;
        mapping(uint256 => uint256) lease_listing_id;
        mapping(uint256 => address) lease_lessee;
        mapping(uint256 => uint256) lease_expires_at;
        mapping(uint256 => uint256) lease_paid_wei;

        // Per-creator stats (aggregate paid earnings net of fee).
        mapping(address => uint256) creator_earnings_wei;

        // Admin / protocol config
        address owner;
        address fee_recipient;
        // bps out of 10000 (e.g. 1000 = 10%)
        uint256 protocol_fee_bps;
        bool initialized;
    }
}

sol! {
    #[derive(Debug)]
    error AlreadyInitialized();
    #[derive(Debug)]
    error NotOwner();
    #[derive(Debug)]
    error NotListingCreator();
    #[derive(Debug)]
    error InvalidPrice();
    #[derive(Debug)]
    error InvalidDuration();
    #[derive(Debug)]
    error EmptyAccHash();
    #[derive(Debug)]
    error UnknownListing();
    #[derive(Debug)]
    error ListingInactive();
    #[derive(Debug)]
    error InsufficientPayment();
    #[derive(Debug)]
    error FeeTooHigh();
    #[derive(Debug)]
    error TransferFailed();

    event ListingCreated(
        uint256 indexed listingId,
        address indexed creator,
        uint256 indexed tokenId,
        uint256 priceWei,
        uint256 durationSecs,
        bytes32 accConditionsHash
    );
    event ListingDeactivated(uint256 indexed listingId, address indexed by);
    event ListingPriceUpdated(uint256 indexed listingId, uint256 newPriceWei);

    /// Primary signal for the Lit relayer.
    event LeaseGranted(
        uint256 indexed leaseId,
        uint256 indexed listingId,
        address indexed lessee,
        uint256 tokenId,
        uint256 paidWei,
        uint256 expiresAt,
        bytes32 accConditionsHash
    );
    event ProtocolFeeUpdated(uint256 newBps);
    event FeeRecipientUpdated(address newRecipient);
    event CreatorPaid(address indexed creator, uint256 indexed listingId, uint256 amount);
}

#[derive(SolidityError, Debug)]
pub enum DataLeaseError {
    AlreadyInitialized(AlreadyInitialized),
    NotOwner(NotOwner),
    NotListingCreator(NotListingCreator),
    InvalidPrice(InvalidPrice),
    InvalidDuration(InvalidDuration),
    EmptyAccHash(EmptyAccHash),
    UnknownListing(UnknownListing),
    ListingInactive(ListingInactive),
    InsufficientPayment(InsufficientPayment),
    FeeTooHigh(FeeTooHigh),
    TransferFailed(TransferFailed),
}

const BPS_DENOM: u64 = 10_000;
const MAX_FEE_BPS: u64 = 3_000; // 30% hard cap

#[public]
impl DataLease {
    pub fn initialize(
        &mut self,
        owner: Address,
        fee_recipient: Address,
        protocol_fee_bps: U256,
    ) -> Result<(), DataLeaseError> {
        if self.initialized.get() {
            return Err(DataLeaseError::AlreadyInitialized(AlreadyInitialized {}));
        }
        if protocol_fee_bps > U256::from(MAX_FEE_BPS) {
            return Err(DataLeaseError::FeeTooHigh(FeeTooHigh {}));
        }
        self.initialized.set(true);
        self.owner.set(owner);
        self.fee_recipient.set(fee_recipient);
        self.protocol_fee_bps.set(protocol_fee_bps);
        Ok(())
    }

    pub fn owner(&self) -> Address { self.owner.get() }

    #[selector(name = "feeRecipient")]
    pub fn fee_recipient(&self) -> Address { self.fee_recipient.get() }

    #[selector(name = "protocolFeeBps")]
    pub fn protocol_fee_bps(&self) -> U256 { self.protocol_fee_bps.get() }

    /// Total listings created (also the next id).
    #[selector(name = "totalListings")]
    pub fn total_listings(&self) -> U256 { self.next_listing_id.get() }

    /// Total leases granted (also the next id).
    #[selector(name = "totalLeases")]
    pub fn total_leases(&self) -> U256 { self.next_lease_id.get() }

    /// Create a new lease listing. Caller is recorded as the creator
    /// (must match the provenance token's creator off-chain — enforced by
    /// indexer / UI).
    #[selector(name = "createListing")]
    pub fn create_listing(
        &mut self,
        token_id: U256,
        price_wei: U256,
        duration_secs: U256,
        acc_conditions_hash: FixedBytes<32>,
    ) -> Result<U256, DataLeaseError> {
        if price_wei == U256::ZERO {
            return Err(DataLeaseError::InvalidPrice(InvalidPrice {}));
        }
        if duration_secs == U256::ZERO {
            return Err(DataLeaseError::InvalidDuration(InvalidDuration {}));
        }
        if acc_conditions_hash == FixedBytes::<32>::ZERO {
            return Err(DataLeaseError::EmptyAccHash(EmptyAccHash {}));
        }
        let creator = self.vm().msg_sender();
        let id = self.next_listing_id.get();

        self.listing_creator.setter(id).set(creator);
        self.listing_token_id.setter(id).set(token_id);
        self.listing_price_wei.setter(id).set(price_wei);
        self.listing_duration_secs.setter(id).set(duration_secs);
        self.listing_acc_hash.setter(id).set(acc_conditions_hash);
        self.listing_active.setter(id).set(true);

        self.next_listing_id.set(id + U256::from(1u64));

        log(
            self.vm(),
            ListingCreated {
                listingId: id,
                creator,
                tokenId: token_id,
                priceWei: price_wei,
                durationSecs: duration_secs,
                accConditionsHash: acc_conditions_hash,
            },
        );
        Ok(id)
    }

    /// Creator-only: turn a listing off (no new leases can be purchased).
    /// Existing leases keep their expiry.
    #[selector(name = "deactivateListing")]
    pub fn deactivate_listing(&mut self, listing_id: U256) -> Result<(), DataLeaseError> {
        self.require_listing(listing_id)?;
        if self.vm().msg_sender() != self.listing_creator.get(listing_id) {
            return Err(DataLeaseError::NotListingCreator(NotListingCreator {}));
        }
        self.listing_active.setter(listing_id).set(false);
        log(
            self.vm(),
            ListingDeactivated {
                listingId: listing_id,
                by: self.vm().msg_sender(),
            },
        );
        Ok(())
    }

    /// Creator-only: change the per-lease price (e.g. dynamic pricing tier).
    #[selector(name = "updateListingPrice")]
    pub fn update_listing_price(
        &mut self,
        listing_id: U256,
        new_price_wei: U256,
    ) -> Result<(), DataLeaseError> {
        self.require_listing(listing_id)?;
        if self.vm().msg_sender() != self.listing_creator.get(listing_id) {
            return Err(DataLeaseError::NotListingCreator(NotListingCreator {}));
        }
        if new_price_wei == U256::ZERO {
            return Err(DataLeaseError::InvalidPrice(InvalidPrice {}));
        }
        self.listing_price_wei.setter(listing_id).set(new_price_wei);
        log(
            self.vm(),
            ListingPriceUpdated {
                listingId: listing_id,
                newPriceWei: new_price_wei,
            },
        );
        Ok(())
    }

    /// Pay msg.value >= price to obtain a time-bound lease.
    /// Lit relayer watches `LeaseGranted` and provisions keys.
    #[payable]
    #[selector(name = "purchaseLease")]
    pub fn purchase_lease(&mut self, listing_id: U256) -> Result<U256, DataLeaseError> {
        self.require_listing(listing_id)?;
        if !self.listing_active.get(listing_id) {
            return Err(DataLeaseError::ListingInactive(ListingInactive {}));
        }
        let price = self.listing_price_wei.get(listing_id);
        let paid = self.vm().msg_value();
        if paid < price {
            return Err(DataLeaseError::InsufficientPayment(InsufficientPayment {}));
        }

        let creator = self.listing_creator.get(listing_id);
        let token_id = self.listing_token_id.get(listing_id);
        let duration = self.listing_duration_secs.get(listing_id);
        let acc_hash = self.listing_acc_hash.get(listing_id);

        // Split: fee_bps to fee_recipient, remainder to creator.
        let fee_bps = self.protocol_fee_bps.get();
        let fee = (price * fee_bps) / U256::from(BPS_DENOM);
        let to_creator = price - fee;

        // Pay protocol fee (skip if zero or no recipient).
        if fee > U256::ZERO {
            let fee_to = self.fee_recipient.get();
            if !fee_to.is_zero() {
                self.vm()
                    .transfer_eth(fee_to, fee)
                    .map_err(|_| DataLeaseError::TransferFailed(TransferFailed {}))?;
            }
        }
        // Pay creator.
        self.vm()
            .transfer_eth(creator, to_creator)
            .map_err(|_| DataLeaseError::TransferFailed(TransferFailed {}))?;

        // Refund overpayment to lessee.
        let lessee = self.vm().msg_sender();
        if paid > price {
            let refund = paid - price;
            self.vm()
                .transfer_eth(lessee, refund)
                .map_err(|_| DataLeaseError::TransferFailed(TransferFailed {}))?;
        }

        let prev_earn = self.creator_earnings_wei.get(creator);
        self.creator_earnings_wei
            .setter(creator)
            .set(prev_earn + to_creator);

        let lease_id = self.next_lease_id.get();
        let now = U256::from(self.vm().block_timestamp());
        let expires_at = now + duration;

        self.lease_listing_id.setter(lease_id).set(listing_id);
        self.lease_lessee.setter(lease_id).set(lessee);
        self.lease_expires_at.setter(lease_id).set(expires_at);
        self.lease_paid_wei.setter(lease_id).set(price);
        self.next_lease_id.set(lease_id + U256::from(1u64));

        log(
            self.vm(),
            CreatorPaid {
                creator,
                listingId: listing_id,
                amount: to_creator,
            },
        );
        log(
            self.vm(),
            LeaseGranted {
                leaseId: lease_id,
                listingId: listing_id,
                lessee,
                tokenId: token_id,
                paidWei: price,
                expiresAt: expires_at,
                accConditionsHash: acc_hash,
            },
        );
        Ok(lease_id)
    }

    // --- View helpers ---

    #[selector(name = "listingCreator")]
    pub fn listing_creator_of(&self, listing_id: U256) -> Result<Address, DataLeaseError> {
        self.require_listing(listing_id)?;
        Ok(self.listing_creator.get(listing_id))
    }

    #[selector(name = "listingTokenId")]
    pub fn listing_token_id_of(&self, listing_id: U256) -> Result<U256, DataLeaseError> {
        self.require_listing(listing_id)?;
        Ok(self.listing_token_id.get(listing_id))
    }

    #[selector(name = "listingPriceWei")]
    pub fn listing_price_of(&self, listing_id: U256) -> Result<U256, DataLeaseError> {
        self.require_listing(listing_id)?;
        Ok(self.listing_price_wei.get(listing_id))
    }

    #[selector(name = "listingDurationSecs")]
    pub fn listing_duration_of(&self, listing_id: U256) -> Result<U256, DataLeaseError> {
        self.require_listing(listing_id)?;
        Ok(self.listing_duration_secs.get(listing_id))
    }

    #[selector(name = "listingAccHash")]
    pub fn listing_acc_hash_of(
        &self,
        listing_id: U256,
    ) -> Result<FixedBytes<32>, DataLeaseError> {
        self.require_listing(listing_id)?;
        Ok(self.listing_acc_hash.get(listing_id))
    }

    #[selector(name = "listingActive")]
    pub fn listing_active_of(&self, listing_id: U256) -> Result<bool, DataLeaseError> {
        self.require_listing(listing_id)?;
        Ok(self.listing_active.get(listing_id))
    }

    #[selector(name = "leaseLessee")]
    pub fn lease_lessee_of(&self, lease_id: U256) -> Address {
        self.lease_lessee.get(lease_id)
    }

    #[selector(name = "leaseExpiresAt")]
    pub fn lease_expires_at_of(&self, lease_id: U256) -> U256 {
        self.lease_expires_at.get(lease_id)
    }

    #[selector(name = "leasePaidWei")]
    pub fn lease_paid_wei_of(&self, lease_id: U256) -> U256 {
        self.lease_paid_wei.get(lease_id)
    }

    #[selector(name = "leaseListingId")]
    pub fn lease_listing_id_of(&self, lease_id: U256) -> U256 {
        self.lease_listing_id.get(lease_id)
    }

    /// Returns true if `lessee` currently holds an unexpired lease for `listing_id`.
    /// O(n) over all leases — fine for a few thousand; index off-chain past that.
    #[selector(name = "hasActiveLease")]
    pub fn has_active_lease(&self, listing_id: U256, lessee: Address) -> bool {
        let now = U256::from(self.vm().block_timestamp());
        let n = self.next_lease_id.get();
        let mut i = U256::ZERO;
        while i < n {
            if self.lease_listing_id.get(i) == listing_id
                && self.lease_lessee.get(i) == lessee
                && self.lease_expires_at.get(i) > now
            {
                return true;
            }
            i = i + U256::from(1u64);
        }
        false
    }

    #[selector(name = "creatorEarnings")]
    pub fn creator_earnings(&self, creator: Address) -> U256 {
        self.creator_earnings_wei.get(creator)
    }

    // --- Admin ---

    #[selector(name = "setProtocolFeeBps")]
    pub fn set_protocol_fee_bps(&mut self, new_bps: U256) -> Result<(), DataLeaseError> {
        self.only_owner()?;
        if new_bps > U256::from(MAX_FEE_BPS) {
            return Err(DataLeaseError::FeeTooHigh(FeeTooHigh {}));
        }
        self.protocol_fee_bps.set(new_bps);
        log(self.vm(), ProtocolFeeUpdated { newBps: new_bps });
        Ok(())
    }

    #[selector(name = "setFeeRecipient")]
    pub fn set_fee_recipient(&mut self, new_recipient: Address) -> Result<(), DataLeaseError> {
        self.only_owner()?;
        self.fee_recipient.set(new_recipient);
        log(
            self.vm(),
            FeeRecipientUpdated {
                newRecipient: new_recipient,
            },
        );
        Ok(())
    }
}

impl DataLease {
    fn only_owner(&self) -> Result<(), DataLeaseError> {
        if self.vm().msg_sender() != self.owner.get() {
            return Err(DataLeaseError::NotOwner(NotOwner {}));
        }
        Ok(())
    }

    fn require_listing(&self, listing_id: U256) -> Result<(), DataLeaseError> {
        if listing_id >= self.next_listing_id.get() {
            return Err(DataLeaseError::UnknownListing(UnknownListing {}));
        }
        Ok(())
    }
}
