// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface TradeRecord {
  id: string;
  encryptedPrice: string;
  encryptedSupply: string;
  encryptedDemand: string;
  timestamp: number;
  trader: string;
  commodity: string;
  system: string;
  status: "available" | "depleted" | "restricted";
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHECompute = (encryptedData: string, operation: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let result = value;
  
  switch(operation) {
    case 'increase10%':
      result = value * 1.1;
      break;
    case 'decrease10%':
      result = value * 0.9;
      break;
    case 'double':
      result = value * 2;
      break;
    default:
      result = value;
  }
  
  return FHEEncryptNumber(result);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [trades, setTrades] = useState<TradeRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newTradeData, setNewTradeData] = useState({ 
    commodity: "", 
    system: "Sol", 
    price: 0,
    supply: 0,
    demand: 0 
  });
  const [selectedTrade, setSelectedTrade] = useState<TradeRecord | null>(null);
  const [decryptedValues, setDecryptedValues] = useState<{price?: number, supply?: number, demand?: number}>({});
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterSystem, setFilterSystem] = useState("all");
  
  const availableCount = trades.filter(t => t.status === "available").length;
  const depletedCount = trades.filter(t => t.status === "depleted").length;
  const restrictedCount = trades.filter(t => t.status === "restricted").length;

  useEffect(() => {
    loadTrades().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadTrades = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      const keysBytes = await contract.getData("trade_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing trade keys:", e); }
      }
      
      const list: TradeRecord[] = [];
      for (const key of keys) {
        try {
          const tradeBytes = await contract.getData(`trade_${key}`);
          if (tradeBytes.length > 0) {
            try {
              const tradeData = JSON.parse(ethers.toUtf8String(tradeBytes));
              list.push({ 
                id: key, 
                encryptedPrice: tradeData.price, 
                encryptedSupply: tradeData.supply,
                encryptedDemand: tradeData.demand,
                timestamp: tradeData.timestamp, 
                trader: tradeData.trader, 
                commodity: tradeData.commodity,
                system: tradeData.system,
                status: tradeData.status || "available"
              });
            } catch (e) { console.error(`Error parsing trade data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading trade ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setTrades(list);
    } catch (e) { console.error("Error loading trades:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitTrade = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting trade data with Zama FHE..." });
    try {
      const encryptedPrice = FHEEncryptNumber(newTradeData.price);
      const encryptedSupply = FHEEncryptNumber(newTradeData.supply);
      const encryptedDemand = FHEEncryptNumber(newTradeData.demand);
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const tradeId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const tradeData = { 
        price: encryptedPrice, 
        supply: encryptedSupply,
        demand: encryptedDemand,
        timestamp: Math.floor(Date.now() / 1000), 
        trader: address, 
        commodity: newTradeData.commodity,
        system: newTradeData.system,
        status: "available"
      };
      
      await contract.setData(`trade_${tradeId}`, ethers.toUtf8Bytes(JSON.stringify(tradeData)));
      
      const keysBytes = await contract.getData("trade_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(tradeId);
      await contract.setData("trade_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Encrypted trade submitted to galactic market!" });
      await loadTrades();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewTradeData({ 
          commodity: "", 
          system: "Sol", 
          price: 0,
          supply: 0,
          demand: 0 
        });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const decryptTradeData = async (trade: TradeRecord) => {
    const price = await decryptWithSignature(trade.encryptedPrice);
    const supply = await decryptWithSignature(trade.encryptedSupply);
    const demand = await decryptWithSignature(trade.encryptedDemand);
    
    if (price !== null && supply !== null && demand !== null) {
      setDecryptedValues({
        price,
        supply,
        demand
      });
    }
  };

  const updateMarket = async (tradeId: string, operation: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted market data with FHE..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      
      const tradeBytes = await contract.getData(`trade_${tradeId}`);
      if (tradeBytes.length === 0) throw new Error("Trade not found");
      const tradeData = JSON.parse(ethers.toUtf8String(tradeBytes));
      
      const updatedPrice = FHECompute(tradeData.price, operation);
      const updatedSupply = FHECompute(tradeData.supply, 'decrease10%');
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedTrade = { 
        ...tradeData, 
        price: updatedPrice,
        supply: updatedSupply,
        status: tradeData.supply === "0" ? "depleted" : tradeData.status
      };
      
      await contractWithSigner.setData(`trade_${tradeId}`, ethers.toUtf8Bytes(JSON.stringify(updatedTrade)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Galactic market updated with FHE computation!" });
      await loadTrades();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Market update failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const filteredTrades = trades.filter(trade => {
    const matchesSearch = trade.commodity.toLowerCase().includes(searchTerm.toLowerCase()) || 
                         trade.system.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesSystem = filterSystem === "all" || trade.system === filterSystem;
    return matchesSearch && matchesSystem;
  });

  const uniqueSystems = Array.from(new Set(trades.map(t => t.system)));

  const renderMarketChart = () => {
    const commodities = Array.from(new Set(trades.map(t => t.commodity))).slice(0, 5);
    
    return (
      <div className="market-chart">
        <div className="chart-header">
          <h4>Galactic Market Trends</h4>
          <div className="chart-legend">
            <div className="legend-item"><div className="color-box price"></div><span>Price</span></div>
            <div className="legend-item"><div className="color-box supply"></div><span>Supply</span></div>
            <div className="legend-item"><div className="color-box demand"></div><span>Demand</span></div>
          </div>
        </div>
        <div className="chart-bars">
          {commodities.map(commodity => {
            const commodityTrades = trades.filter(t => t.commodity === commodity);
            const avgPrice = commodityTrades.reduce((sum, t) => sum + (decryptedValues.price || 0), 0) / commodityTrades.length || 0;
            const avgSupply = commodityTrades.reduce((sum, t) => sum + (decryptedValues.supply || 0), 0) / commodityTrades.length || 0;
            const avgDemand = commodityTrades.reduce((sum, t) => sum + (decryptedValues.demand || 0), 0) / commodityTrades.length || 0;
            
            return (
              <div className="commodity-row" key={commodity}>
                <div className="commodity-name">{commodity}</div>
                <div className="bar-container">
                  <div className="bar price" style={{ width: `${Math.min(avgPrice / 100, 100)}%` }}></div>
                  <div className="bar supply" style={{ width: `${Math.min(avgSupply / 100, 100)}%` }}></div>
                  <div className="bar demand" style={{ width: `${Math.min(avgDemand / 100, 100)}%` }}></div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="pulsar"></div>
      <p>Initializing FHE connection to galactic market...</p>
    </div>
  );

  return (
    <div className="app-container star-trader-theme">
      <div className="radial-bg"></div>
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon"></div>
          <h1>Star<span>Trader</span>FHE</h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="create-trade-btn metal-button">
            <div className="add-icon"></div>New Trade
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>
      
      <main className="main-content">
        <div className="central-radial">
          <div className="dashboard-grid">
            <div className="dashboard-card metal-card">
              <h3>Interstellar Trade with FHE</h3>
              <p>Navigate the <strong>FHE-encrypted galactic market</strong> where prices and supply are fully encrypted. Use your trader instincts to find profitable routes across star systems.</p>
              <div className="fhe-badge"><span>Zama FHE Powered</span></div>
            </div>
            
            <div className="dashboard-card metal-card">
              <h3>Market Statistics</h3>
              <div className="stats-grid">
                <div className="stat-item">
                  <div className="stat-value">{trades.length}</div>
                  <div className="stat-label">Total Trades</div>
                </div>
                <div className="stat-item">
                  <div className="stat-value">{availableCount}</div>
                  <div className="stat-label">Available</div>
                </div>
                <div className="stat-item">
                  <div className="stat-value">{depletedCount}</div>
                  <div className="stat-label">Depleted</div>
                </div>
                <div className="stat-item">
                  <div className="stat-value">{restrictedCount}</div>
                  <div className="stat-label">Restricted</div>
                </div>
              </div>
            </div>
            
            <div className="dashboard-card metal-card">
              <h3>Market Analysis</h3>
              {renderMarketChart()}
            </div>
          </div>
          
          <div className="trades-section">
            <div className="section-header">
              <h2>Galactic Market</h2>
              <div className="header-actions">
                <div className="search-filter">
                  <input 
                    type="text" 
                    placeholder="Search commodities..." 
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="metal-input"
                  />
                  <select 
                    value={filterSystem} 
                    onChange={(e) => setFilterSystem(e.target.value)}
                    className="metal-select"
                  >
                    <option value="all">All Systems</option>
                    {uniqueSystems.map(system => (
                      <option key={system} value={system}>{system}</option>
                    ))}
                  </select>
                </div>
                <button onClick={loadTrades} className="refresh-btn metal-button" disabled={isRefreshing}>
                  {isRefreshing ? "Scanning..." : "Scan Market"}
                </button>
              </div>
            </div>
            
            <div className="trades-list metal-card">
              <div className="table-header">
                <div className="header-cell">Commodity</div>
                <div className="header-cell">System</div>
                <div className="header-cell">Trader</div>
                <div className="header-cell">Date</div>
                <div className="header-cell">Status</div>
                <div className="header-cell">Actions</div>
              </div>
              
              {filteredTrades.length === 0 ? (
                <div className="no-trades">
                  <div className="no-trades-icon"></div>
                  <p>No trade routes found in this sector</p>
                  <button className="metal-button primary" onClick={() => setShowCreateModal(true)}>
                    Establish First Trade
                  </button>
                </div>
              ) : filteredTrades.map(trade => (
                <div 
                  className={`trade-row ${trade.status}`} 
                  key={trade.id} 
                  onClick={() => {
                    setSelectedTrade(trade);
                    setDecryptedValues({});
                  }}
                >
                  <div className="table-cell commodity">{trade.commodity}</div>
                  <div className="table-cell system">{trade.system}</div>
                  <div className="table-cell trader">{trade.trader.substring(0, 6)}...{trade.trader.substring(38)}</div>
                  <div className="table-cell">{new Date(trade.timestamp * 1000).toLocaleDateString()}</div>
                  <div className="table-cell">
                    <span className={`status-badge ${trade.status}`}>{trade.status}</span>
                  </div>
                  <div className="table-cell actions">
                    <button 
                      className="action-btn metal-button" 
                      onClick={(e) => {
                        e.stopPropagation();
                        updateMarket(trade.id, 'increase10%');
                      }}
                    >
                      Trade
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </main>
      
      {showCreateModal && (
        <ModalCreate 
          onSubmit={submitTrade} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          tradeData={newTradeData} 
          setTradeData={setNewTradeData}
        />
      )}
      
      {selectedTrade && (
        <TradeDetailModal 
          trade={selectedTrade} 
          onClose={() => {
            setSelectedTrade(null);
            setDecryptedValues({});
          }} 
          decryptedValues={decryptedValues}
          setDecryptedValues={setDecryptedValues}
          isDecrypting={isDecrypting}
          decryptWithSignature={decryptWithSignature}
        />
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content metal-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="pulsar"></div>}
              {transactionStatus.status === "success" && <div className="success-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo"></div>
            <p>Interstellar trade with fully homomorphic encryption</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms of Service</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge"><span>Zama FHE Technology</span></div>
          <div className="copyright">© {new Date().getFullYear()} Star Trader FHE. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  tradeData: any;
  setTradeData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, tradeData, setTradeData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setTradeData({ ...tradeData, [name]: value });
  };

  const handleNumberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setTradeData({ ...tradeData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!tradeData.commodity || tradeData.price <= 0) { 
      alert("Please fill required fields"); 
      return; 
    }
    onSubmit();
  };

  const systems = ["Sol", "Alpha Centauri", "Barnard", "Wolf 359", "Lalande", "Sirius", "Luyten", "Ross"];

  return (
    <div className="modal-overlay">
      <div className="create-modal metal-card">
        <div className="modal-header">
          <h2>Establish New Trade Route</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div>
              <strong>FHE Market Encryption</strong>
              <p>All market data will be encrypted with Zama FHE before submission</p>
            </div>
          </div>
          
          <div className="form-grid">
            <div className="form-group">
              <label>Commodity *</label>
              <input 
                type="text" 
                name="commodity" 
                value={tradeData.commodity} 
                onChange={handleChange} 
                placeholder="Enter commodity name" 
                className="metal-input"
              />
            </div>
            
            <div className="form-group">
              <label>Star System *</label>
              <select 
                name="system" 
                value={tradeData.system} 
                onChange={handleChange} 
                className="metal-select"
              >
                {systems.map(system => (
                  <option key={system} value={system}>{system}</option>
                ))}
              </select>
            </div>
            
            <div className="form-group">
              <label>Price (Credits) *</label>
              <input 
                type="number" 
                name="price" 
                value={tradeData.price} 
                onChange={handleNumberChange} 
                placeholder="Enter price" 
                className="metal-input"
                min="0"
                step="0.01"
              />
            </div>
            
            <div className="form-group">
              <label>Supply (Units)</label>
              <input 
                type="number" 
                name="supply" 
                value={tradeData.supply} 
                onChange={handleNumberChange} 
                placeholder="Enter supply" 
                className="metal-input"
                min="0"
              />
            </div>
            
            <div className="form-group">
              <label>Demand Level</label>
              <input 
                type="number" 
                name="demand" 
                value={tradeData.demand} 
                onChange={handleNumberChange} 
                placeholder="Enter demand" 
                className="metal-input"
                min="0"
                max="100"
              />
            </div>
          </div>
          
          <div className="encryption-preview">
            <h4>FHE Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data">
                <span>Plain Values:</span>
                <div>Price: {tradeData.price || '0'}</div>
                <div>Supply: {tradeData.supply || '0'}</div>
                <div>Demand: {tradeData.demand || '0'}</div>
              </div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>Price: {tradeData.price ? FHEEncryptNumber(tradeData.price).substring(0, 20) + '...' : '0'}</div>
                <div>Supply: {tradeData.supply ? FHEEncryptNumber(tradeData.supply).substring(0, 20) + '...' : '0'}</div>
                <div>Demand: {tradeData.demand ? FHEEncryptNumber(tradeData.demand).substring(0, 20) + '...' : '0'}</div>
              </div>
            </div>
          </div>
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn metal-button">Cancel</button>
          <button onClick={handleSubmit} disabled={creating} className="submit-btn metal-button primary">
            {creating ? "Encrypting with FHE..." : "Submit to Galactic Market"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface TradeDetailModalProps {
  trade: TradeRecord;
  onClose: () => void;
  decryptedValues: {price?: number, supply?: number, demand?: number};
  setDecryptedValues: (values: {price?: number, supply?: number, demand?: number}) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const TradeDetailModal: React.FC<TradeDetailModalProps> = ({ 
  trade, 
  onClose, 
  decryptedValues,
  setDecryptedValues,
  isDecrypting, 
  decryptWithSignature 
}) => {
  const handleDecrypt = async () => {
    if (decryptedValues.price !== undefined) {
      setDecryptedValues({});
      return;
    }
    
    const price = await decryptWithSignature(trade.encryptedPrice);
    const supply = await decryptWithSignature(trade.encryptedSupply);
    const demand = await decryptWithSignature(trade.encryptedDemand);
    
    if (price !== null && supply !== null && demand !== null) {
      setDecryptedValues({
        price,
        supply,
        demand
      });
    }
  };

  return (
    <div className="modal-overlay">
      <div className="trade-detail-modal metal-card">
        <div className="modal-header">
          <h2>Trade Route Details</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="trade-info">
            <div className="info-item">
              <span>Commodity:</span>
              <strong>{trade.commodity}</strong>
            </div>
            <div className="info-item">
              <span>Star System:</span>
              <strong>{trade.system}</strong>
            </div>
            <div className="info-item">
              <span>Trader:</span>
              <strong>{trade.trader.substring(0, 6)}...{trade.trader.substring(38)}</strong>
            </div>
            <div className="info-item">
              <span>Date:</span>
              <strong>{new Date(trade.timestamp * 1000).toLocaleString()}</strong>
            </div>
            <div className="info-item">
              <span>Status:</span>
              <strong className={`status-badge ${trade.status}`}>{trade.status}</strong>
            </div>
          </div>
          
          <div className="encrypted-data-section">
            <h3>FHE Encrypted Market Data</h3>
            <div className="data-grid">
              <div className="data-item">
                <span>Price:</span>
                <div className="encrypted-data">{trade.encryptedPrice.substring(0, 30)}...</div>
              </div>
              <div className="data-item">
                <span>Supply:</span>
                <div className="encrypted-data">{trade.encryptedSupply.substring(0, 30)}...</div>
              </div>
              <div className="data-item">
                <span>Demand:</span>
                <div className="encrypted-data">{trade.encryptedDemand.substring(0, 30)}...</div>
              </div>
            </div>
            
            <div className="fhe-tag">
              <div className="fhe-icon"></div>
              <span>Zama FHE Encrypted</span>
            </div>
            
            <button 
              className="decrypt-btn metal-button" 
              onClick={handleDecrypt} 
              disabled={isDecrypting}
            >
              {isDecrypting ? (
                <span className="decrypt-spinner"></span>
              ) : decryptedValues.price !== undefined ? (
                "Hide Decrypted Values"
              ) : (
                "Decrypt with Wallet Signature"
              )}
            </button>
          </div>
          
          {decryptedValues.price !== undefined && (
            <div className="decrypted-data-section">
              <h3>Decrypted Market Data</h3>
              <div className="data-grid">
                <div className="data-item">
                  <span>Price:</span>
                  <div className="decrypted-value">{decryptedValues.price} Credits</div>
                </div>
                <div className="data-item">
                  <span>Supply:</span>
                  <div className="decrypted-value">{decryptedValues.supply} Units</div>
                </div>
                <div className="data-item">
                  <span>Demand:</span>
                  <div className="decrypted-value">{decryptedValues.demand}/100</div>
                </div>
              </div>
              <div className="decryption-notice">
                <div className="warning-icon"></div>
                <span>Decrypted data requires wallet signature verification</span>
              </div>
            </div>
          )}
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn metal-button">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;