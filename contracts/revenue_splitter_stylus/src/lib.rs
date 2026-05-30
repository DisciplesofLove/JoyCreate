#![cfg_attr(not(any(test, feature = "export-abi")), no_std)]
extern crate alloc;

use alloc::{vec, vec::Vec};

#[cfg(not(any(test, feature = "export-abi")))]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}

use alloy_primitives::{Address, U256};
use stylus_sdk::{alloy_sol_types::sol, prelude::*};

/// RevenueSplitter — atomic 80 / 10 / 10 payout for the X402 pay-per-prompt
/// rail.
///
/// The X402 facilitator settles a payment by submitting the payer's signed
/// EIP-3009 `transferWithAuthorization`, sending the full USDC amount to THIS
/// contract. It then calls `distribute(token, creator, amount)` which fans the
/// payment out:
///   - 80% to the creator,
///   - 10% to the platform wallet,
///   - 10% to the protocol wallet (receives any rounding remainder).
///
/// Splits are ERC-20 transfers via a cross-contract call, so the splitter is
/// asset-agnostic (USDC by default, any EIP-20 token works). Only the owner
/// (the facilitator) may trigger a distribution.
sol_interface! {
    interface IErc20 {
        function balanceOf(address account) external view returns (uint256);
        function transfer(address to, uint256 value) external returns (bool);
    }
}

sol_storage! {
    #[entrypoint]
    pub struct RevenueSplitter {
        address owner;
        address platform_wallet;
        address protocol_wallet;
        // basis points out of 10000.
        uint256 creator_bps;
        uint256 platform_bps;
        uint256 protocol_bps;
        // token => creator => cumulative creator payout
        mapping(address => mapping(address => uint256)) creator_earnings;
        // token => cumulative amount distributed
        mapping(address => uint256) total_distributed;
        bool initialized;
    }
}

sol! {
    #[derive(Debug)]
    error AlreadyInitialized();
    #[derive(Debug)]
    error NotOwner();
    #[derive(Debug)]
    error ZeroAddress();
    #[derive(Debug)]
    error InvalidAmount();
    #[derive(Debug)]
    error InsufficientBalance();
    #[derive(Debug)]
    error TransferFailed();

    /// Emitted on each successful distribution.
    event RevenueSplit(
        address indexed token,
        address indexed creator,
        uint256 amount,
        uint256 creatorAmount,
        uint256 platformAmount,
        uint256 protocolAmount
    );

    event WalletsUpdated(address platformWallet, address protocolWallet);
}

#[derive(SolidityError, Debug)]
pub enum SplitError {
    AlreadyInitialized(AlreadyInitialized),
    NotOwner(NotOwner),
    ZeroAddress(ZeroAddress),
    InvalidAmount(InvalidAmount),
    InsufficientBalance(InsufficientBalance),
    TransferFailed(TransferFailed),
}

#[public]
impl RevenueSplitter {
    /// One-time init. Sets the caller as owner, records the payout wallets and
    /// the default 80 / 10 / 10 split.
    pub fn initialize(
        &mut self,
        platform_wallet: Address,
        protocol_wallet: Address,
    ) -> Result<(), SplitError> {
        if self.initialized.get() {
            return Err(SplitError::AlreadyInitialized(AlreadyInitialized {}));
        }
        if platform_wallet == Address::ZERO || protocol_wallet == Address::ZERO {
            return Err(SplitError::ZeroAddress(ZeroAddress {}));
        }
        self.initialized.set(true);
        self.owner.set(self.vm().msg_sender());
        self.platform_wallet.set(platform_wallet);
        self.protocol_wallet.set(protocol_wallet);
        self.creator_bps.set(U256::from(8000u64));
        self.platform_bps.set(U256::from(1000u64));
        self.protocol_bps.set(U256::from(1000u64));
        Ok(())
    }

    /// Contract owner (the X402 facilitator).
    #[selector(name = "owner")]
    pub fn owner(&self) -> Address {
        self.owner.get()
    }

    /// Update the platform / protocol payout wallets. Owner only.
    #[selector(name = "setWallets")]
    pub fn set_wallets(
        &mut self,
        platform_wallet: Address,
        protocol_wallet: Address,
    ) -> Result<bool, SplitError> {
        self.require_owner()?;
        if platform_wallet == Address::ZERO || protocol_wallet == Address::ZERO {
            return Err(SplitError::ZeroAddress(ZeroAddress {}));
        }
        self.platform_wallet.set(platform_wallet);
        self.protocol_wallet.set(protocol_wallet);
        log(
            self.vm(),
            WalletsUpdated {
                platformWallet: platform_wallet,
                protocolWallet: protocol_wallet,
            },
        );
        Ok(true)
    }

    /// Distribute `amount` of `token` held by this contract: 80% to `creator`,
    /// 10% to the platform wallet, 10% (plus rounding remainder) to the
    /// protocol wallet. Owner only.
    #[selector(name = "distribute")]
    pub fn distribute(
        &mut self,
        token: Address,
        creator: Address,
        amount: U256,
    ) -> Result<bool, SplitError> {
        self.require_owner()?;
        if creator == Address::ZERO || token == Address::ZERO {
            return Err(SplitError::ZeroAddress(ZeroAddress {}));
        }
        if amount == U256::ZERO {
            return Err(SplitError::InvalidAmount(InvalidAmount {}));
        }
        self.split_internal(token, creator, amount)
    }

    /// Distribute the FULL current balance of `token` held by this contract,
    /// using the same 80 / 10 / 10 split. Owner only.
    #[selector(name = "distributeAll")]
    pub fn distribute_all(
        &mut self,
        token: Address,
        creator: Address,
    ) -> Result<bool, SplitError> {
        self.require_owner()?;
        if creator == Address::ZERO || token == Address::ZERO {
            return Err(SplitError::ZeroAddress(ZeroAddress {}));
        }
        let erc20 = IErc20::new(token);
        let self_addr = self.vm().contract_address();
        let balance = erc20
            .balance_of(&*self, self_addr)
            .map_err(|_| SplitError::TransferFailed(TransferFailed {}))?;
        if balance == U256::ZERO {
            return Err(SplitError::InvalidAmount(InvalidAmount {}));
        }
        self.split_internal(token, creator, balance)
    }

    /// Cumulative payout a creator has received in `token`.
    #[selector(name = "creatorEarnings")]
    pub fn creator_earnings(&self, token: Address, creator: Address) -> U256 {
        self.creator_earnings.getter(token).get(creator)
    }

    /// Cumulative amount of `token` distributed through this splitter.
    #[selector(name = "totalDistributed")]
    pub fn total_distributed(&self, token: Address) -> U256 {
        self.total_distributed.get(token)
    }

    /// Returns (owner, platformWallet, protocolWallet, creatorBps,
    /// platformBps, protocolBps).
    #[selector(name = "getConfig")]
    pub fn get_config(&self) -> (Address, Address, Address, U256, U256, U256) {
        (
            self.owner.get(),
            self.platform_wallet.get(),
            self.protocol_wallet.get(),
            self.creator_bps.get(),
            self.platform_bps.get(),
            self.protocol_bps.get(),
        )
    }
}

impl RevenueSplitter {
    fn require_owner(&self) -> Result<(), SplitError> {
        if self.vm().msg_sender() != self.owner.get() {
            return Err(SplitError::NotOwner(NotOwner {}));
        }
        Ok(())
    }

    /// Shared split math + transfers. Caller guarantees `amount > 0` and
    /// non-zero addresses.
    fn split_internal(
        &mut self,
        token: Address,
        creator: Address,
        amount: U256,
    ) -> Result<bool, SplitError> {
        let erc20 = IErc20::new(token);
        let self_addr = self.vm().contract_address();
        let balance = erc20
            .balance_of(&*self, self_addr)
            .map_err(|_| SplitError::TransferFailed(TransferFailed {}))?;
        if balance < amount {
            return Err(SplitError::InsufficientBalance(InsufficientBalance {}));
        }

        let bps = U256::from(10000u64);
        let creator_amount = amount * self.creator_bps.get() / bps;
        let platform_amount = amount * self.platform_bps.get() / bps;
        // Protocol receives the remainder so the sum always equals `amount`.
        let protocol_amount = amount - creator_amount - platform_amount;

        let platform = self.platform_wallet.get();
        let protocol = self.protocol_wallet.get();

        if creator_amount > U256::ZERO {
            erc20
                .transfer(&mut *self, creator, creator_amount)
                .map_err(|_| SplitError::TransferFailed(TransferFailed {}))?;
        }
        if platform_amount > U256::ZERO {
            erc20
                .transfer(&mut *self, platform, platform_amount)
                .map_err(|_| SplitError::TransferFailed(TransferFailed {}))?;
        }
        if protocol_amount > U256::ZERO {
            erc20
                .transfer(&mut *self, protocol, protocol_amount)
                .map_err(|_| SplitError::TransferFailed(TransferFailed {}))?;
        }

        let prev = self.creator_earnings.getter(token).get(creator);
        self.creator_earnings
            .setter(token)
            .setter(creator)
            .set(prev + creator_amount);
        let prev_total = self.total_distributed.get(token);
        self.total_distributed.setter(token).set(prev_total + amount);

        log(
            self.vm(),
            RevenueSplit {
                token,
                creator,
                amount,
                creatorAmount: creator_amount,
                platformAmount: platform_amount,
                protocolAmount: protocol_amount,
            },
        );
        Ok(true)
    }
}
