// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {NameCodec} from "./NameCodec.sol";

/// @title NameRegistry
/// @notice On-chain name registry: ownership, DNS records, listings and settlement.
/// @dev No admin. Rules and the annual fee are fixed at deploy time.
contract NameRegistry {

    // 365 days per registration or renewal
    uint64 public constant LEASE = 365 days;

    // Annual fee, fixed at deploy time
    uint256 public immutable FEE;

    // Fees collected but not swept yet
    uint256 public uncollectedFee;

    // Per-name state: 20 + 4 + 8 bytes fill one slot, signingKey takes another
    struct Name {
        address owner;
        uint32 keyVersion;
        uint64 expiry;
        address signingKey;
    }

    // Listing: deadline 0 means open-ended, active means listed
    struct Sale {
        address buyer;
        uint96 price;
        uint64 deadline;
        bool active;
    }

    // Names
    mapping(bytes32 id => Name) private _names;
    // Listings
    mapping(bytes32 id => Sale) private _sales;
    // DNS records, overwritten as a whole
    mapping(bytes32 id => bytes) private _records;

    // Sale proceeds the seller can withdraw
    mapping(address account => uint256) private _earnings;

    // Names with a registry listing, in listing order
    string[] private _listed;

    // Index in _listed plus one
    mapping(bytes32 id => uint256) private _listedAt;

    // Names held by an address
    mapping(address who => string[]) private _ownedNames;

    // Index in _ownedNames plus one
    mapping(address who => mapping(bytes32 id => uint256)) private _ownedAt;

    // Events: emitted on every state change; clients rebuild history from them
    event Registered(bytes32 indexed id, string name, address indexed owner, uint64 expiry, uint256 fee);
    event Renewed(bytes32 indexed id, string name, uint64 expiry, uint256 fee);
    event Transferred(bytes32 indexed id, string name, address indexed from, address indexed to);
    event SigningKeyChanged(bytes32 indexed id, string name, address indexed signingKey, uint32 keyVersion);
    event SaleApproved(
        bytes32 indexed id, string name, address indexed buyer, uint96 price, uint64 deadline, bool persist
    );
    event SaleCancelled(bytes32 indexed id, string name);
    event Settled(bytes32 indexed id, string name, address indexed buyer, address indexed seller, uint96 price);
    event RecordsUpdated(bytes32 indexed id, string name, address indexed writer);
    event Expired(bytes32 indexed id, string name);
    event EarningsCredited(address indexed account, uint256 amount, uint256 earnings);
    event EarningsWithdrawn(address indexed account, uint256 amount);
    event Swept(address indexed to, uint256 amount);

    // Custom errors: cheaper than strings, easy to translate client-side
    error NameTaken();
    error NotRegistered();
    error NotOwner();
    error NotBuyer();
    error WrongPrice();
    error SaleHasExpired();
    error NoSale();
    error NotAuthorized();
    error BadRecipient();
    error ZeroFee();
    error BadDeadline();
    error NothingToWithdraw();
    error NothingToSweep();
    error FeeTransferFailed();
    error TransferFailed();
    error WrongFee();

    // Fee must be non-zero and cannot change after deploy
    constructor(uint256 fee) {
        if (fee == 0) revert ZeroFee();
        FEE = fee;
    }

    // Register: first come first served, one annual fee
    function register(string calldata name) external payable returns (bytes32 id) {
        if (msg.value != FEE) revert WrongFee();

        id = NameCodec.hash(name);

        _touch(id, name);
        if (_names[id].owner != address(0)) revert NameTaken();

        _names[id] = Name({
            owner: msg.sender,
            keyVersion: 0,
            expiry: uint64(block.timestamp) + LEASE,
            signingKey: msg.sender
        });

        _ownedAdd(msg.sender, id, name);

        emit Registered(id, name, msg.sender, _names[id].expiry, msg.value);

        uncollectedFee += msg.value;
    }

    // Renew: extends expiry only, ownership unchanged
    function renew(string calldata name) external payable {
        if (msg.value != FEE) revert WrongFee();

        bytes32 id = _activeId(name);
        Name storage n = _names[id];
        if (msg.sender != n.owner) revert NotOwner();

        uint64 now64 = uint64(block.timestamp);
        uint64 base = n.expiry > now64 ? n.expiry : now64;
        n.expiry = base + LEASE;

        emit Renewed(id, name, n.expiry, msg.value);
        uncollectedFee += msg.value;
    }

    // Change the DNS editor key; version increments and old signatures die
    function setSigningKey(string calldata name, address key) external {
        bytes32 id = _activeId(name);
        Name storage n = _names[id];
        if (msg.sender != n.owner) revert NotOwner();
        if (key == address(0)) revert BadRecipient();

        n.signingKey = key;
        n.keyVersion += 1;

        emit SigningKeyChanged(id, name, key, n.keyVersion);
    }

    // List: buyer 0 means public sale, deadline 0 means open-ended
    function approveSale(
        string calldata name,
        address buyer,
        uint96 price,
        uint64 deadline,
        bool persist
    ) external {
        bytes32 id = _activeId(name);
        if (msg.sender != _names[id].owner) revert NotOwner();
        if (deadline != 0 && deadline <= block.timestamp) revert BadDeadline();

        _sales[id] = Sale({buyer: buyer, price: price, deadline: deadline, active: true});

        if (persist) {
            _listAdd(id, name);
        } else {
            _listRemove(id);
        }

        emit SaleApproved(id, name, buyer, price, deadline, persist);
    }

    // Cancel the listing
    function cancelApproval(string calldata name) external {
        bytes32 id = NameCodec.hash(name);
        _touch(id, name);
        Name storage n = _names[id];
        if (n.owner == address(0)) revert NotRegistered();
        if (msg.sender != n.owner) revert NotOwner();

        _dropSale(id);

        emit SaleCancelled(id, name);
    }

    // Clear listings that already expired; valid ones stay
    function pruneExpired(string calldata name) external {
        bytes32 id = NameCodec.hash(name);
        Sale storage s = _sales[id];
        if (!s.active || s.deadline == 0 || s.deadline >= block.timestamp) revert NoSale();

        _dropSale(id);

        emit SaleCancelled(id, name);
    }

    // Settle: checks, payment, ownership, listing cleanup and credit in one tx
    function buy(string calldata name) external payable {
        bytes32 id = NameCodec.hash(name);
        _touch(id, name);

        Name storage n = _names[id];
        if (n.owner == address(0)) revert NotRegistered();

        Sale memory s = _sales[id];
        if (!s.active) revert NoSale();
        if (s.buyer != address(0) && msg.sender != s.buyer) revert NotBuyer();
        if (msg.value != s.price) revert WrongPrice();
        if (s.deadline != 0 && block.timestamp > s.deadline) revert SaleHasExpired();

        address seller = n.owner;

        _transferOwnership(id, name, msg.sender);

        if (s.price > 0) {
            _earnings[seller] += s.price;
            emit EarningsCredited(seller, s.price, _earnings[seller]);
        }
        emit Settled(id, name, msg.sender, seller, s.price);
    }

    // Write DNS records; owner or signingKey only
    function setRecords(string calldata name, bytes calldata data) external {
        bytes32 id = _activeId(name);
        Name storage n = _names[id];
        if (msg.sender != n.owner && msg.sender != n.signingKey) revert NotAuthorized();

        _records[id] = data;

        emit RecordsUpdated(id, name, msg.sender);
    }

    // Read DNS records
    function getRecords(string calldata name) external view returns (bytes memory) {
        return _records[NameCodec.hash(name)];
    }

    // Send collected fees to the given address; anyone can call
    function sweep(address payable to) external {
        if (to == address(0)) revert BadRecipient();

        uint256 amount = uncollectedFee;
        if (amount == 0) revert NothingToSweep();

        uncollectedFee = 0;
        emit Swept(to, amount);

        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert FeeTransferFailed();
    }

    // Seller withdraws sale proceeds
    function withdraw() external {
        uint256 amount = _earnings[msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        _earnings[msg.sender] = 0;
        emit EarningsWithdrawn(msg.sender, amount);

        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // Read the listing
    function saleOf(string calldata name)
        external
        view
        returns (address buyer, uint96 price, uint64 deadline, bool active)
    {
        Sale storage s = _sales[NameCodec.hash(name)];
        return (s.buyer, s.price, s.deadline, s.active);
    }

    // Number of names held
    function domainCount(address who) external view returns (uint256) {
        return _ownedNames[who].length;
    }

    // Names held by an address
    function domainsOf(address who) external view returns (string[] memory) {
        return _ownedNames[who];
    }

    // Number of registry listings
    function listedCount() external view returns (uint256) {
        return _listed.length;
    }

    // Page through registry listings
    function listedNames(uint256 offset, uint256 limit)
        external
        view
        returns (string[] memory page)
    {
        uint256 total = _listed.length;
        if (offset >= total) return new string[](0);

        uint256 end = offset + limit;
        if (end > total) end = total;

        page = new string[](end - offset);
        for (uint256 i = offset; i < end; ) {
            page[i - offset] = _listed[i];
            unchecked {
                ++i;
            }
        }
    }

    // Withdrawable amount
    function earningsOf(address account) external view returns (uint256) {
        return _earnings[account];
    }

    // Name state; expired names read as empty
    function resolve(string calldata name)
        external
        view
        returns (address owner, address signingKey, uint32 keyVersion, uint64 expiry)
    {
        bytes32 id = NameCodec.hash(name);
        Name storage n = _names[id];

        if (n.owner == address(0) || n.expiry <= block.timestamp) {
            return (address(0), address(0), 0, 0);
        }
        return (n.owner, n.signingKey, n.keyVersion, n.expiry);
    }

    // Whether the name can be registered now
    function isAvailable(string calldata name) external view returns (bool) {
        bytes32 id = NameCodec.hash(name);
        Name storage n = _names[id];
        return n.owner == address(0) || n.expiry <= block.timestamp;
    }

    // Name hash, exposed for clients
    function namehash(string calldata name) external pure returns (bytes32) {
        return NameCodec.hash(name);
    }

    // Maintain the address-to-name index
    function _ownedAdd(address who, bytes32 id, string calldata name) private {
        if (_ownedAt[who][id] != 0) return;
        _ownedNames[who].push(NameCodec.normalize(name));
        _ownedAt[who][id] = _ownedNames[who].length;
    }

    // Remove from the index
    function _ownedRemove(address who, bytes32 id) private {
        uint256 pos = _ownedAt[who][id];
        if (pos == 0) return;

        string[] storage arr = _ownedNames[who];
        uint256 idx = pos - 1;
        uint256 last = arr.length - 1;

        if (idx != last) {
            string memory moved = arr[last];
            arr[idx] = moved;
            _ownedAt[who][NameCodec.hashNormalized(moved)] = idx + 1;
        }
        arr.pop();
        delete _ownedAt[who][id];
    }

    // Add to the registry listing
    function _listAdd(bytes32 id, string calldata name) private {
        if (_listedAt[id] != 0) return;
        _listed.push(NameCodec.normalize(name));
        _listedAt[id] = _listed.length;
    }

    // Clear the listing and refund storage
    function _dropSale(bytes32 id) private {
        delete _sales[id];
        _listRemove(id);
    }

    // Remove from the registry listing
    function _listRemove(bytes32 id) private {
        uint256 pos = _listedAt[id];
        if (pos == 0) return;

        uint256 idx = pos - 1;
        uint256 last = _listed.length - 1;
        if (idx != last) {
            string memory moved = _listed[last];
            _listed[idx] = moved;
            _listedAt[NameCodec.hashNormalized(moved)] = idx + 1;
        }
        _listed.pop();
        delete _listedAt[id];
    }

    // Reclaim if expired; every write calls it first
    function _touch(bytes32 id, string calldata name) private {
        Name storage n = _names[id];
        if (n.owner != address(0) && n.expiry <= block.timestamp) {
            _ownedRemove(n.owner, id);
            delete _names[id];
            delete _sales[id];
            delete _records[id];
            _listRemove(id);
            emit Expired(id, name);
        }
    }

    // Resolve an active name, revert if missing or expired
    function _activeId(string calldata name) private returns (bytes32 id) {
        id = NameCodec.hash(name);
        _touch(id, name);
        if (_names[id].owner == address(0)) revert NotRegistered();
    }

    // The only path that changes ownership
    function _transferOwnership(bytes32 id, string calldata name, address to) private {
        if (to == address(0)) revert BadRecipient();

        Name storage n = _names[id];
        address from = n.owner;

        _ownedRemove(from, id);
        _ownedAdd(to, id, name);

        n.owner = to;
        n.signingKey = to;
        n.keyVersion += 1;
        _dropSale(id);

        emit Transferred(id, name, from, to);
    }
}
