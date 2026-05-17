#![cfg_attr(not(any(test, feature = "export-abi")), no_std)]
extern crate alloc;

use alloc::{vec, vec::Vec};

#[cfg(not(any(test, feature = "export-abi")))]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}

use alloy_primitives::{Address, U256};
use openzeppelin_stylus::token::erc1155::{self, Erc1155, IErc1155};
use stylus_sdk::{abi::Bytes, alloy_sol_types::sol, prelude::*};

// =============================================================================
// DropEdition — audited ERC-1155 mint surface for the JoyCreate marketplace.
//
// SECURITY MODEL
//   • Token mechanics (balances, transfers, approvals, ERC-1155 events) are
//     delegated to `openzeppelin_stylus::token::erc1155::Erc1155` v0.3.0 — the
//     audited OpenZeppelin Contracts for Stylus implementation.
//   • Only the wrapper logic (initialize, owner, mint price/state, payable
//     mint, withdraw) is local. It is intentionally small and reviewable.
//   • `initialize(owner, mint_price)` is callable once. The deploy script
//     MUST call it atomically with the same wallet that ran `cargo stylus
//     deploy` to eliminate the front-run window. Even if a front-runner
//     initialized first, no user funds are at risk because `mint_active`
//     defaults to `false` and only the initialized owner can flip it on.
// =============================================================================

sol_storage! {
    #[entrypoint]
    pub struct DropEdition {
        #[borrow]
        Erc1155 erc1155;
        address owner;
        uint256 mint_price;
        bool mint_active;
        bool initialized;
    }
}

sol! {
    #[derive(Debug)]
    error NotOwner();
    #[derive(Debug)]
    error AlreadyInitialized();
    #[derive(Debug)]
    error MintInactive();
    #[derive(Debug)]
    error InsufficientPayment();
    #[derive(Debug)]
    error WithdrawFailed();
    #[derive(Debug)]
    error InvalidRecipient();

    event Initialized(address indexed owner, uint256 mint_price);
    event MintActiveChanged(bool active);
    event PriceChanged(uint256 new_price);
    event Withdrawn(address indexed to, uint256 amount);
}

#[derive(SolidityError, Debug)]
pub enum DropEditionError {
    NotOwner(NotOwner),
    AlreadyInitialized(AlreadyInitialized),
    MintInactive(MintInactive),
    InsufficientPayment(InsufficientPayment),
    WithdrawFailed(WithdrawFailed),
    InvalidRecipient(InvalidRecipient),
}

#[public]
impl DropEdition {
    pub fn initialize(
        &mut self,
        owner: Address,
        mint_price: U256,
    ) -> Result<(), DropEditionError> {
        if self.initialized.get() {
            return Err(DropEditionError::AlreadyInitialized(AlreadyInitialized {}));
        }
        if owner.is_zero() {
            return Err(DropEditionError::InvalidRecipient(InvalidRecipient {}));
        }
        self.initialized.set(true);
        self.owner.set(owner);
        self.mint_price.set(mint_price);
        self.mint_active.set(false);
        log(self.vm(), Initialized { owner, mint_price });
        Ok(())
    }

    pub fn owner(&self) -> Address {
        self.owner.get()
    }

    /// ERC-1155 balanceOf — delegates to the audited OZ implementation.
    #[selector(name = "balanceOf")]
    pub fn balance_of(&self, account: Address, id: U256) -> U256 {
        self.erc1155.balance_of(account, id)
    }

    #[selector(name = "mintPrice")]
    pub fn mint_price(&self) -> U256 {
        self.mint_price.get()
    }

    #[selector(name = "mintActive")]
    pub fn mint_active(&self) -> bool {
        self.mint_active.get()
    }

    #[selector(name = "setMintState")]
    pub fn set_mint_state(&mut self, active: bool) -> Result<(), DropEditionError> {
        self.only_owner()?;
        self.mint_active.set(active);
        log(self.vm(), MintActiveChanged { active });
        Ok(())
    }

    #[selector(name = "setMintPrice")]
    pub fn set_mint_price(&mut self, new_price: U256) -> Result<(), DropEditionError> {
        self.only_owner()?;
        self.mint_price.set(new_price);
        log(self.vm(), PriceChanged { new_price });
        Ok(())
    }

    #[payable]
    #[selector(name = "mintEdition")]
    pub fn mint_edition(
        &mut self,
        to: Address,
        id: U256,
        amount: U256,
    ) -> Result<(), Vec<u8>> {
        if to.is_zero() {
            return Err(DropEditionError::InvalidRecipient(InvalidRecipient {}).into());
        }
        if !self.mint_active.get() {
            return Err(DropEditionError::MintInactive(MintInactive {}).into());
        }
        let required = self.mint_price.get() * amount;
        if self.vm().msg_value() < required {
            return Err(DropEditionError::InsufficientPayment(InsufficientPayment {}).into());
        }
        let empty: Bytes = Vec::new().into();
        self.erc1155
            ._mint(to, id, amount, &empty)
            .map_err(|e: erc1155::Error| Vec::<u8>::from(e))
    }

    pub fn withdraw(&mut self, to: Address) -> Result<(), Vec<u8>> {
        self.only_owner().map_err(Vec::<u8>::from)?;
        if to.is_zero() {
            return Err(Vec::<u8>::from(DropEditionError::InvalidRecipient(
                InvalidRecipient {},
            )));
        }
        let bal = self.vm().balance(self.vm().contract_address());
        self.vm()
            .transfer_eth(to, bal)
            .map_err(|_| Vec::<u8>::from(DropEditionError::WithdrawFailed(WithdrawFailed {})))?;
        log(self.vm(), Withdrawn { to, amount: bal });
        Ok(())
    }
}

impl DropEdition {
    fn only_owner(&self) -> Result<(), DropEditionError> {
        if self.vm().msg_sender() != self.owner.get() {
            return Err(DropEditionError::NotOwner(NotOwner {}));
        }
        Ok(())
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use stylus_sdk::testing::*;

    #[test]
    fn initialize_only_once() {
        let vm = TestVM::default();
        let mut c = DropEdition::from(&vm);
        let owner = vm.msg_sender();
        c.initialize(owner, U256::from(1000u64)).unwrap();
        assert!(c.initialize(owner, U256::from(1u64)).is_err());
        assert_eq!(c.owner(), owner);
        assert_eq!(c.mint_price(), U256::from(1000u64));
        assert!(!c.mint_active());
    }

    #[test]
    fn set_mint_state_owner_only() {
        let vm = TestVM::default();
        let mut c = DropEdition::from(&vm);
        let owner = vm.msg_sender();
        c.initialize(owner, U256::from(0u64)).unwrap();
        c.set_mint_state(true).unwrap();
        assert!(c.mint_active());
        vm.set_sender(Address::from([0xBEu8; 20]));
        assert!(c.set_mint_state(false).is_err());
    }

    #[test]
    fn mint_requires_active() {
        let vm = TestVM::default();
        let mut c = DropEdition::from(&vm);
        let owner = vm.msg_sender();
        c.initialize(owner, U256::from(0u64)).unwrap();
        assert!(c
            .mint_edition(owner, U256::from(1u64), U256::from(1u64))
            .is_err());
    }

    #[test]
    fn mint_happy_path() {
        let vm = TestVM::default();
        let mut c = DropEdition::from(&vm);
        let owner = vm.msg_sender();
        c.initialize(owner, U256::from(0u64)).unwrap();
        c.set_mint_state(true).unwrap();
        c.mint_edition(owner, U256::from(7u64), U256::from(3u64))
            .unwrap();
        assert_eq!(
            c.balance_of(owner, U256::from(7u64)),
            U256::from(3u64)
        );
    }
}
