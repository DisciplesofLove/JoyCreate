#![cfg_attr(not(any(test, feature = "export-abi")), no_std)]
extern crate alloc;

use alloc::{vec, vec::Vec};

#[cfg(not(any(test, feature = "export-abi")))]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}

use alloy_primitives::{Address, FixedBytes, U256};
use stylus_sdk::{abi::Bytes, alloy_sol_types::sol, prelude::*};

/// Data Provenance Token (DPT).
///
/// Mints an immutable on-chain record proving a specific human creator
/// authored a body of work. The token does NOT hold the raw data — that
/// remains encrypted on Pinata (gated by Lit Protocol). What is anchored
/// on-chain:
///   - the creator's wallet (the human stamp),
///   - the IPLD merkle root of the work (cryptographic identity),
///   - the encrypted content URI (Pinata CID, etc.),
///   - a human-proof hash (e.g. signed attestation digest from a
///     personhood oracle / device-attested signing key),
///   - the timestamp.
///
/// Tokens are non-transferable (soulbound) — the audit trail must remain
/// bound to the creator. Lease/access economics are handled by a separate
/// DataLease contract that references the provenance tokenId.
sol_storage! {
    #[entrypoint]
    pub struct DataProvenance {
        // monotonic id counter (next id to mint).
        uint256 next_id;
        // tokenId => creator
        mapping(uint256 => address) creators;
        // tokenId => merkle root (IPLD DAG root)
        mapping(uint256 => bytes32) merkle_roots;
        // tokenId => encrypted content URI (Pinata CID / lit-encrypted ref) as raw bytes
        mapping(uint256 => bytes) content_uris;
        // tokenId => human-proof attestation digest
        mapping(uint256 => bytes32) human_proofs;
        // tokenId => mint timestamp
        mapping(uint256 => uint256) minted_at;
        // creator => count
        mapping(address => uint256) creator_counts;
        // owner of contract (admin for emergency revocation; not transfer).
        address owner;
        bool initialized;
    }
}

sol! {
    #[derive(Debug)]
    error AlreadyInitialized();
    #[derive(Debug)]
    error NotOwner();
    #[derive(Debug)]
    error EmptyMerkleRoot();
    #[derive(Debug)]
    error EmptyContentUri();
    #[derive(Debug)]
    error UnknownToken();

    /// Emitted on every successful provenance mint. Off-chain indexers
    /// (Joy Create's exchange UI) listen to this to populate the catalog.
    event ProvenanceMinted(
        uint256 indexed tokenId,
        address indexed creator,
        bytes32 indexed merkleRoot,
        bytes32 humanProof,
        bytes contentURI,
        uint256 mintedAt
    );

    /// Admin can flag a token as revoked (e.g. takedown). Off-chain
    /// listeners should hide leases for revoked tokens.
    event ProvenanceRevoked(uint256 indexed tokenId, address indexed by);
}

#[derive(SolidityError, Debug)]
pub enum DataProvenanceError {
    AlreadyInitialized(AlreadyInitialized),
    NotOwner(NotOwner),
    EmptyMerkleRoot(EmptyMerkleRoot),
    EmptyContentUri(EmptyContentUri),
    UnknownToken(UnknownToken),
}

#[public]
impl DataProvenance {
    /// One-time admin init. Deployer should call in same tx batch.
    pub fn initialize(&mut self, owner: Address) -> Result<(), DataProvenanceError> {
        if self.initialized.get() {
            return Err(DataProvenanceError::AlreadyInitialized(AlreadyInitialized {}));
        }
        self.initialized.set(true);
        self.owner.set(owner);
        Ok(())
    }

    pub fn owner(&self) -> Address {
        self.owner.get()
    }

    /// Next id that will be assigned by `mint_provenance` (also = totalSupply).
    #[selector(name = "totalSupply")]
    pub fn total_supply(&self) -> U256 {
        self.next_id.get()
    }

    /// Mint a new provenance token. Caller is recorded as the creator
    /// (the human stamp — wallet acts as identity anchor).
    #[selector(name = "mintProvenance")]
    pub fn mint_provenance(
        &mut self,
        merkle_root: FixedBytes<32>,
        content_uri: Bytes,
        human_proof: FixedBytes<32>,
    ) -> Result<U256, DataProvenanceError> {
        if merkle_root == FixedBytes::<32>::ZERO {
            return Err(DataProvenanceError::EmptyMerkleRoot(EmptyMerkleRoot {}));
        }
        if content_uri.is_empty() {
            return Err(DataProvenanceError::EmptyContentUri(EmptyContentUri {}));
        }
        let creator = self.vm().msg_sender();
        let id = self.next_id.get();
        let now = U256::from(self.vm().block_timestamp());

        self.creators.setter(id).set(creator);
        self.merkle_roots.setter(id).set(merkle_root);
        self.content_uris.setter(id).set_bytes(content_uri.as_slice());
        self.human_proofs.setter(id).set(human_proof);
        self.minted_at.setter(id).set(now);

        let prev = self.creator_counts.get(creator);
        self.creator_counts.setter(creator).set(prev + U256::from(1u64));

        self.next_id.set(id + U256::from(1u64));

        log(
            self.vm(),
            ProvenanceMinted {
                tokenId: id,
                creator,
                merkleRoot: merkle_root,
                humanProof: human_proof,
                contentURI: content_uri.to_vec().into(),
                mintedAt: now,
            },
        );
        Ok(id)
    }

    #[selector(name = "creatorOf")]
    pub fn creator_of(&self, token_id: U256) -> Result<Address, DataProvenanceError> {
        self.require_exists(token_id)?;
        Ok(self.creators.get(token_id))
    }

    #[selector(name = "merkleRootOf")]
    pub fn merkle_root_of(
        &self,
        token_id: U256,
    ) -> Result<FixedBytes<32>, DataProvenanceError> {
        self.require_exists(token_id)?;
        Ok(self.merkle_roots.get(token_id))
    }

    #[selector(name = "contentUriOf")]
    pub fn content_uri_of(
        &self,
        token_id: U256,
    ) -> Result<Bytes, DataProvenanceError> {
        self.require_exists(token_id)?;
        Ok(self.content_uris.getter(token_id).get_bytes().into())
    }

    #[selector(name = "humanProofOf")]
    pub fn human_proof_of(
        &self,
        token_id: U256,
    ) -> Result<FixedBytes<32>, DataProvenanceError> {
        self.require_exists(token_id)?;
        Ok(self.human_proofs.get(token_id))
    }

    #[selector(name = "mintedAt")]
    pub fn minted_at_of(&self, token_id: U256) -> Result<U256, DataProvenanceError> {
        self.require_exists(token_id)?;
        Ok(self.minted_at.get(token_id))
    }

    #[selector(name = "creatorCount")]
    pub fn creator_count(&self, creator: Address) -> U256 {
        self.creator_counts.get(creator)
    }

    /// Admin emergency: emit a revocation event. Storage is NOT wiped
    /// (provenance must remain auditable) — downstream lease contract
    /// will refuse to grant new access on revoked tokens.
    #[selector(name = "revoke")]
    pub fn revoke(&mut self, token_id: U256) -> Result<(), DataProvenanceError> {
        self.only_owner()?;
        self.require_exists(token_id)?;
        log(
            self.vm(),
            ProvenanceRevoked {
                tokenId: token_id,
                by: self.vm().msg_sender(),
            },
        );
        Ok(())
    }
}

impl DataProvenance {
    fn only_owner(&self) -> Result<(), DataProvenanceError> {
        if self.vm().msg_sender() != self.owner.get() {
            return Err(DataProvenanceError::NotOwner(NotOwner {}));
        }
        Ok(())
    }

    fn require_exists(&self, token_id: U256) -> Result<(), DataProvenanceError> {
        if token_id >= self.next_id.get() {
            return Err(DataProvenanceError::UnknownToken(UnknownToken {}));
        }
        Ok(())
    }
}
