# DropEdition (Arbitrum Stylus)

ERC-1155 with native-ETH-priced mints. Built with `openzeppelin-stylus 0.3.0` on `stylus-sdk 0.9.0`.

> **Status: scaffold.** Compile + deploy on a developer machine with the Rust toolchain. The JoyCreate runtime defaults to Polygon Amoy; this contract only takes effect when a user opts into Arbitrum via Settings → Marketplace network.

## Build & deploy (manual)

```bash
# 1. Toolchain (one time)
rustup target add wasm32-unknown-unknown
cargo install --force cargo-stylus

# 2. From this directory
cargo stylus check                   # validates the WASM is Stylus-compatible
cargo test                           # runs the unit tests in src/main.rs
cargo stylus export-abi --features export-abi > abi/DropEdition.sol

# 3. Deploy to Arbitrum Sepolia (uses cargo-stylus default public RPC)
cargo stylus deploy --private-key="0xDEV_KEY"

# 4. Initialize ONCE (front-running risk on shared chains — see C-FIX-1)
cast send <CONTRACT_ADDRESS> "initialize(address,uint256)" <OWNER> <PRICE_WEI> \
  --rpc-url https://sepolia-rollup.arbitrum.io/rpc --private-key 0xDEV_KEY
cast send <CONTRACT_ADDRESS> "set_mint_state(bool)" true \
  --rpc-url https://sepolia-rollup.arbitrum.io/rpc --private-key 0xDEV_KEY
```

After deploy, paste the contract address into `src/config/joymarketplace.ts` →
`ARBITRUM_SEPOLIA_STYLUS_CONTRACTS.dropEdition`.

## Mainnet checklist

Before deploying to Arbitrum One, address the three known issues:

- **C-FIX-1** — `initialize()` is callable by anyone; the first caller wins. Either bundle initialize into the deploy tx batch, or replace the open `initialize` with a hardcoded `DEPLOYER` constant or Stylus 0.9 `#[constructor]`.
- **C-FIX-2** — Already shipped: `withdraw(address)` lets the owner pull accumulated ETH out of the contract.
- **C-FIX-3** — Already shipped: `MintActiveChanged` and `PriceChanged` events are emitted; ensure the JoyCreate listener subscribes if you need them.

## ABI surface (Solidity-style)

```
function initialize(address owner, uint256 mint_price)
function mint_edition(address to, uint256 id, uint256 amount) payable
function set_mint_state(bool active)
function set_mint_price(uint256 new_price)
function withdraw(address to)
function balanceOf(address account, uint256 id) view returns (uint256)
event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)
event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)
event ApprovalForAll(address indexed account, address indexed operator, bool approved)
event Initialized(address indexed owner, uint256 mint_price)
event MintActiveChanged(bool active)
event PriceChanged(uint256 new_price)
event Withdrawn(address indexed to, uint256 amount)
```

`TransferSingle` with `from == address(0)` is the mint signal the JoyCreate
`drop_event_listener` uses to fire `asset.claimed`.
