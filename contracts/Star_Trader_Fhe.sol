pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract StarTraderFhe is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;
    uint256 public cooldownSeconds = 30;
    bool public paused = false;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    struct Batch {
        uint256 id;
        bool isOpen;
        uint256 itemCount;
    }
    mapping(uint256 => Batch) public batches;
    uint256 public currentBatchId = 1;

    euint32 internal encryptedTotalMarketVolume;
    euint32 internal encryptedAverageTradeProfit;
    euint32 internal encryptedPlayerTradeCount;
    euint32 internal encryptedPlayerTradeVolume;
    euint32 internal encryptedPlayerTradeProfit;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event CooldownSet(uint256 oldCooldown, uint256 newCooldown);
    event ContractPaused(address indexed account);
    event ContractUnpaused(address indexed account);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event TradeDataSubmitted(address indexed provider, uint256 indexed batchId, uint256 itemCount);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 totalMarketVolume, uint256 averageTradeProfit, uint256 playerTradeCount, uint256 playerTradeVolume, uint256 playerTradeProfit);

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosed();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidBatchId();
    error BatchStillOpen();
    error InvalidCooldown();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier submissionRateLimited() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier decryptionRateLimited() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        _initIfNeeded();
        _openNewBatch();
    }

    function _initIfNeeded() internal {
        if (!encryptedTotalMarketVolume.isInitialized()) {
            encryptedTotalMarketVolume = FHE.asEuint32(0);
            encryptedAverageTradeProfit = FHE.asEuint32(0);
            encryptedPlayerTradeCount = FHE.asEuint32(0);
            encryptedPlayerTradeVolume = FHE.asEuint32(0);
            encryptedPlayerTradeProfit = FHE.asEuint32(0);
        }
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function setCooldown(uint256 newCooldownSeconds) external onlyOwner {
        if (newCooldownSeconds == 0) revert InvalidCooldown();
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSet(oldCooldown, newCooldownSeconds);
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit ContractPaused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit ContractUnpaused(msg.sender);
    }

    function _openNewBatch() internal {
        Batch storage newBatch = batches[currentBatchId];
        newBatch.id = currentBatchId;
        newBatch.isOpen = true;
        newBatch.itemCount = 0;
        emit BatchOpened(currentBatchId);
    }

    function closeCurrentBatch() external onlyOwner {
        if (!batches[currentBatchId].isOpen) revert BatchClosed();
        batches[currentBatchId].isOpen = false;
        emit BatchClosed(currentBatchId);
        currentBatchId++;
        _openNewBatch();
    }

    function submitTradeData(
        euint32 calldata marketVolume,
        euint32 calldata tradeProfit,
        euint32 calldata playerCount,
        euint32 calldata playerVolume,
        euint32 calldata playerProfit
    ) external onlyProvider whenNotPaused submissionRateLimited {
        if (!batches[currentBatchId].isOpen) revert BatchClosed();
        _initIfNeeded();

        encryptedTotalMarketVolume = encryptedTotalMarketVolume.add(marketVolume);
        encryptedAverageTradeProfit = encryptedAverageTradeProfit.add(tradeProfit);
        encryptedPlayerTradeCount = encryptedPlayerTradeCount.add(playerCount);
        encryptedPlayerTradeVolume = encryptedPlayerTradeVolume.add(playerVolume);
        encryptedPlayerTradeProfit = encryptedPlayerTradeProfit.add(playerProfit);

        batches[currentBatchId].itemCount++;
        lastSubmissionTime[msg.sender] = block.timestamp;
        emit TradeDataSubmitted(msg.sender, currentBatchId, batches[currentBatchId].itemCount);
    }

    function requestMarketSummaryDecryption(uint256 batchIdToDecrypt) external whenNotPaused decryptionRateLimited {
        if (batchIdToDecrypt >= currentBatchId) revert InvalidBatchId();
        if (batches[batchIdToDecrypt].isOpen) revert BatchStillOpen();

        euint32 memory totalMarketVolume = encryptedTotalMarketVolume;
        euint32 memory averageTradeProfit = encryptedAverageTradeProfit;
        euint32 memory playerTradeCount = encryptedPlayerTradeCount;
        euint32 memory playerTradeVolume = encryptedPlayerTradeVolume;
        euint32 memory playerTradeProfit = encryptedPlayerTradeProfit;

        bytes32[] memory cts = new bytes32[](5);
        cts[0] = totalMarketVolume.toBytes32();
        cts[1] = averageTradeProfit.toBytes32();
        cts[2] = playerTradeCount.toBytes32();
        cts[3] = playerTradeVolume.toBytes32();
        cts[4] = playerTradeProfit.toBytes32();

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({ batchId: batchIdToDecrypt, stateHash: stateHash, processed: false });
        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, batchIdToDecrypt, stateHash);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();
        // Security: Replay protection ensures a request is processed only once.

        Batch memory targetBatch = batches[decryptionContexts[requestId].batchId];

        euint32 memory totalMarketVolume = encryptedTotalMarketVolume;
        euint32 memory averageTradeProfit = encryptedAverageTradeProfit;
        euint32 memory playerTradeCount = encryptedPlayerTradeCount;
        euint32 memory playerTradeVolume = encryptedPlayerTradeVolume;
        euint32 memory playerTradeProfit = encryptedPlayerTradeProfit;

        bytes32[] memory cts = new bytes32[](5);
        cts[0] = totalMarketVolume.toBytes32();
        cts[1] = averageTradeProfit.toBytes32();
        cts[2] = playerTradeCount.toBytes32();
        cts[3] = playerTradeVolume.toBytes32();
        cts[4] = playerTradeProfit.toBytes32();

        bytes32 currentHash = _hashCiphertexts(cts);
        // Security: State verification ensures that the contract state (ciphertexts)
        // has not changed between the decryption request and this callback.
        // This prevents scenarios where an attacker might try to alter the state
        // to get a different decryption outcome for the same request.
        if (currentHash != decryptionContexts[requestId].stateHash) revert StateMismatch();

        FHE.checkSignatures(requestId, cleartexts, proof);

        uint256 totalMarketVolumeCleartext = abi.decode(cleartexts[0:32], (uint256));
        uint256 averageTradeProfitCleartext = abi.decode(cleartexts[32:64], (uint256));
        uint256 playerTradeCountCleartext = abi.decode(cleartexts[64:96], (uint256));
        uint256 playerTradeVolumeCleartext = abi.decode(cleartexts[96:128], (uint256));
        uint256 playerTradeProfitCleartext = abi.decode(cleartexts[128:160], (uint256));

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, decryptionContexts[requestId].batchId, totalMarketVolumeCleartext, averageTradeProfitCleartext, playerTradeCountCleartext, playerTradeVolumeCleartext, playerTradeProfitCleartext);
    }
}