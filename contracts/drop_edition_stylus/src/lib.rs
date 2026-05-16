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

sol_storage! {
    #[entrypoint]
    pub struct DropEdition {
        // id => (account => balance)
        mapping(uint256 => mapping(address => uint256)) balances;
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

    // ERC-1155 standard event so off-chain indexers can listen.
    event TransferSingle(
        address indexed operator,
        address indexed from,
        address indexed to,
        uint256 id,
        uint256 value
    );
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
    /// Initialize the contract. First caller wins (deploy + initialize must
    /// be in same tx batch — see C-FIX-1).
    pub fn initialize(
        &mut self,
        owner: Address,
        mint_price: U256,
    ) -> Result<(), DropEditionError> {
        if self.initialized.get() {
            return Err(DropEditionError::AlreadyInitialized(AlreadyInitialized {}));
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

    pub fn mint_price(&self) -> U256 {
        self.mint_price.get()
    }

    pub fn mint_active(&self) -> bool {
        self.mint_active.get()
    }

    /// ERC-1155 balanceOf.
    #[selector(name = "balanceOf")]
    pub fn balance_of(&self, account: Address, id: U256) -> U256 {
        self.balances.getter(id).get(account)
    }

    /// ERC-165 supportsInterface (claims ERC-165 + ERC-1155).
    #[selector(name = "supportsInterface")]
    pub fn supports_interface(&self, interface_id: FixedBytes<4>) -> bool {
        let bytes: [u8; 4] = interface_id.into();
        // ERC-165: 0x01ffc9a7  | ERC-1155: 0xd9b67a26
        bytes == [0x01, 0xff, 0xc9, 0xa7] || bytes == [0xd9, 0xb6, 0x7a, 0x26]
    }

    /// Owner-only: toggle mint state.
    pub fn set_mint_state(&mut self, active: bool) -> Result<(), DropEditionError> {
        self.only_owner()?;
        self.mint_active.set(active);
        log(self.vm(), MintActiveChanged { active });
        Ok(())
    }

    /// Owner-only: change per-edition price (wei).
    pub fn set_mint_price(&mut self, new_price: U256) -> Result<(), DropEditionError> {
        self.only_owner()?;
        self.mint_price.set(new_price);
        log(self.vm(), PriceChanged { new_price });
        Ok(())
    }

    /// Pay msg.value == mint_price * amount to mint `amount` of token `id` to `to`.
    /// Emits ERC-1155 TransferSingle from address(0).
    #[payable]
    pub fn mint_edition(
        &mut self,
        to: Address,
        id: U256,
        amount: U256,
    ) -> Result<(), DropEditionError> {
        if to.is_zero() {
            return Err(DropEditionError::InvalidRecipient(InvalidRecipient {}));
        }
        if !self.mint_active.get() {
            return Err(DropEditionError::MintInactive(MintInactive {}));
        }
        let required = self.mint_price.get() * amount;
        if self.vm().msg_value() < required {
            return Err(DropEditionError::InsufficientPayment(InsufficientPayment {}));
        }
        let sender = self.vm().msg_sender();
        let mut id_map = self.balances.setter(id);
        let prev = id_map.get(to);
        id_map.setter(to).set(prev + amount);
        log(
            self.vm(),
            TransferSingle {
                operator: sender,
                from: Address::ZERO,
                to,
                id,
                value: amount,
            },
        );
        Ok(())
    }

    /// Owner-only: withdraw all ETH (C-FIX-2).
    pub fn withdraw(&mut self, to: Address) -> Result<(), Vec<u8>> {
        self.only_owner().map_err(Vec::<u8>::from)?;
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
