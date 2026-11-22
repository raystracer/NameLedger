// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title NameCodec
/// @notice Name normalization and hashing.
library NameCodec {
    // Max total length
    uint256 internal constant MAX_NAME_LENGTH = 253;

    // Max length per label
    uint256 internal constant MAX_LABEL_LENGTH = 63;

    // Invalid name cases
    error EmptyName();

    error NameTooLong(uint256 length);

    error BadCharacter(uint256 index, bytes1 ch);

    error BadLabel(uint256 index);

    error NoDot();

    // Lowercase and validate, return the canonical form
    function normalize(string calldata raw) internal pure returns (string memory) {
        bytes calldata src = bytes(raw);
        uint256 len = src.length;

        if (len == 0) revert EmptyName();
        if (len > MAX_NAME_LENGTH) revert NameTooLong(len);

        bytes memory out = new bytes(len);
        uint256 labelLen;
        bool sawDot;

        for (uint256 i = 0; i < len; ++i) {
            bytes1 c = src[i];

            if (c == 0x2E) {
                if (labelLen == 0) revert BadLabel(i);
                if (out[i - 1] == 0x2D) revert BadLabel(i);
                sawDot = true;
                labelLen = 0;
                out[i] = c;
                continue;
            }

            if (c >= 0x41 && c <= 0x5A) {
                c = bytes1(uint8(c) + 32);
            } else if (
                !(
                    (c >= 0x61 && c <= 0x7A)
                        || (c >= 0x30 && c <= 0x39)
                        || c == 0x2D
                )
            ) {
                revert BadCharacter(i, src[i]);
            }

            if (c == 0x2D && labelLen == 0) revert BadLabel(i);
            if (labelLen >= MAX_LABEL_LENGTH) revert BadLabel(i);

            out[i] = c;
            ++labelLen;
        }

        if (labelLen == 0) revert BadLabel(len);
        if (out[len - 1] == 0x2D) revert BadLabel(len - 1);
        if (!sawDot) revert NoDot();

        return string(out);
    }

    // Normalize then hash
    function hash(string calldata name) internal pure returns (bytes32) {
        return keccak256(bytes(normalize(name)));
    }

    // Already canonical, hash directly
    function hashNormalized(string memory name) internal pure returns (bytes32) {
        return keccak256(bytes(name));
    }
}
