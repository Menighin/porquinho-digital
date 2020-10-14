import fs from 'fs';
import StockUtils from '../utils/StockUtils';
import FileSystemUtils from '../utils/FileSystemUtils';
import UpdateStockHistoryJob from '../jobs/UpdateStockHistoryJob';
import DividendsService from './DividendsService';
import { dialog } from 'electron';
import CsvUtils from '../../src-shared/utils/CsvUtils';

const FILES = {
    JOB_METADATA: 'stock_history_job',
    STOCK_HISTORY: 'stock_history'
};

const CSV_HEADERS = [
    {
        code: 'account',
        label: 'Conta',
        type: 'string'
    },
    {
        code: 'institution',
        label: 'Instituição',
        type: 'string'
    },
    {
        code: 'code',
        label: 'Ativo',
        type: 'string'
    },
    {
        code: 'operation',
        label: 'Operação',
        type: 'string'
    },
    {
        code: 'date',
        label: 'Data',
        type: 'date'
    },
    {
        code: 'quantity',
        label: 'Quantidade',
        type: 'integer'
    },
    {
        code: 'price',
        label: 'Preço',
        type: 'float'
    },
    {
        code: 'source',
        label: 'Fonte'
    }
];

class StockHistoryService {

    async getStockHistoryJobMetadata() {
        const rootPath = await FileSystemUtils.getDataPath();
        const path = `${rootPath}/${FILES.JOB_METADATA}`;

        const fileStr = (await fs.promises.readFile(path, { flag: 'a+', encoding: 'utf-8' })).toString();
        let result = null;
        if (fileStr.length > 0) {
            result = JSON.parse(fileStr);
            result.lastRun = new Date(result.lastRun);
        }
        return result;
    }

    async updateStockHistoryJobMetadata(lastRun = undefined) {
        const rootPath = await FileSystemUtils.getDataPath();
        const path = `${rootPath}/${FILES.JOB_METADATA}`;

        const metadata = await this.getStockHistoryJobMetadata() || {};
        metadata.lastRun = typeof lastRun === 'undefined' ? new Date() : lastRun;
        await fs.promises.writeFile(path, JSON.stringify(metadata));
    }

    async saveStockHistory(stocks, overwrite = false) {
        const rootPath = await FileSystemUtils.getDataPath();
        const path = `${rootPath}/${FILES.STOCK_HISTORY}`;

        if (!overwrite) {
            // Reading data
            const stockHistory = await this.getStockHistory();

            // Merging / appending data
            for (const newStock of stocks) {
                let alreadySaved = false;
                for (const savedStock of stockHistory) {
                    if (newStock.institution === savedStock.institution && newStock.account === savedStock.account) {
                        for (const newOperation of newStock.stockHistory) {
                            let foundOperation = false;
                            for (let i = 0; i < savedStock.stockHistory.length; i++) {
                                if (savedStock.stockHistory[i].id === newOperation.id) {
                                    savedStock.stockHistory[i] = newOperation;
                                    foundOperation = true;
                                    break;
                                }
                            }
                            if (!foundOperation)
                                savedStock.stockHistory.push(newOperation);
                        }
                        alreadySaved = true;
                    }
                }
                // If this is a new item, simply push it
                if (!alreadySaved) {
                    stockHistory.push(newStock);
                }
            }

            // Writing data
            await fs.promises.writeFile(path, JSON.stringify(stockHistory));
        } else {
            await fs.promises.writeFile(path, JSON.stringify(stocks));
        }
    }

    async getStockHistory() {
        const rootPath = await FileSystemUtils.getDataPath();
        const path = `${rootPath}/${FILES.STOCK_HISTORY}`;

        const stockHistory = JSON.parse((await fs.promises.readFile(path, { flag: 'a+', encoding: 'utf-8' })).toString() || '[]');
        stockHistory.forEach(acc => {
            acc.stockHistory.forEach(s => {
                s.date = new Date(s.date);
            });
        });
        return stockHistory;
    }

    async getStockHistoryOperations() {
        return (await this.getStockHistory())
            .reduce((p, c) => {
                p = [...p, ...c.stockHistory.map(s => ({
                    ...s,
                    date: new Date(s.date),
                    institution: c.institution,
                    account: c.account
                }))];
                return p;
            }, []);
    }

    async getConsolidatedStockHistory(startDate = null, endDate = null) {
        const averagePrices = await this.getAveragePrices(endDate);
        const profitLoss = await this.getProfitLoss(startDate, endDate);
        const stockHistoryFiltered = (await this.getStockHistoryOperations())
            .filter(o => (endDate === null || o.date <= endDate));

        const dividendsByStock = (await DividendsService.getDividendsEvents())
            .filter(d => (startDate === null || startDate <= d.date) && (endDate === null || d.date <= endDate))
            .reduce((p, c) => {
                if (!p[c.code]) p[c.code] = 0;
                p[c.code] += c.netValue;
                return p;
            }, {});

        const consolidatedByStock = stockHistoryFiltered.reduce((p, c) => {
            const key = StockUtils.getStockCode(c.code);
            if (!(key in p)) {
                p[key] = {
                    code: key,
                    quantityBought: 0,
                    quantitySold: 0,
                    valueBought: 0,
                    valueSold: 0,
                    quantityBalanceEver: 0,
                    buyOperations: 0,
                    sellOperations: 0,
                    operationsByInstitution: {}
                };
            }

            if (startDate === null || startDate <= c.date) {

                if (!(c.institution in p[key].operationsByInstitution))
                p[key].operationsByInstitution[c.institution] = {
                    buy: 0,
                    sell: 0
                };

                if (c.operation === 'C') {
                    p[key].quantityBought += c.quantity;
                    p[key].valueBought += c.price * c.quantity;
                    p[key].buyOperations++;
                    p[key].operationsByInstitution[c.institution].buy++;
                } else if (c.operation === 'V') {
                    p[key].quantitySold += c.quantity;
                    p[key].valueSold += c.price * c.quantity;
                    p[key].sellOperations++;
                    p[key].operationsByInstitution[c.institution].sell++;
                }
                p[key].quantityBalance = Math.max(p[key].quantityBought - p[key].quantitySold, 0);
            }

            if (c.operation === 'C')
                p[key].quantityBalanceEver += c.quantity;
            else if (c.operation === 'V')
                p[key].quantityBalanceEver -= c.quantity;

            // p[key].quantityBalanceEver = Math.max(p[key].quantityBalanceEver, 0);
            return p;
        }, {});

        Object.keys(consolidatedByStock).forEach(code => {
            consolidatedByStock[code].averageBuyPrice = averagePrices[code] ? averagePrices[code].averageBuyPrice : 0;
            consolidatedByStock[code].averageSellPrice = averagePrices[code] ? averagePrices[code].averageSellPrice : 0;
            consolidatedByStock[code].profitLoss = profitLoss[code] || 0;
            consolidatedByStock[code].valueBalance = consolidatedByStock[code].quantityBalance * consolidatedByStock[code].averageBuyPrice;
            consolidatedByStock[code].dividends = dividendsByStock[code] || 0;
        });

        return Object.values(consolidatedByStock).sort((a, b) => (a.code > b.code) ? 1 : ((b.code > a.code) ? -1 : 0));
    }

    async getAveragePrices(endDate = null) {
        const stockOperations = (await this.getStockHistoryOperations())
            .filter(o => endDate === null || o.date <= endDate);

        const totalsByStock = stockOperations
            .reduce((p, c) => {
                const key = StockUtils.getStockCode(c.code);
                if (!p[key])
                    p[key] = {
                        quantityBought: 0,
                        valueBought: 0,
                        quantitySold: 0,
                        valueSold: 0
                    };

                if (c.operation === 'C') {
                    p[key].quantityBought += c.quantity;
                    p[key].valueBought += c.price * c.quantity;
                } else if (c.operation === 'V') {
                    p[key].quantitySold += c.quantity;
                    p[key].valueSold += c.price * c.quantity;
                }
                return p;
            }, {});

        return Object.keys(totalsByStock).reduce((p, c) => {
            const totals = totalsByStock[c];
            p[c] = {};
            p[c].averageBuyPrice = totals.quantityBought > 0 ? totals.valueBought / totals.quantityBought : 0;
            p[c].averageSellPrice = totals.quantitySold > 0 ? totals.valueSold / totals.quantitySold : 0;
            return p;
        }, {});
    }

    async getProfitLoss(startDate = null, endDate = null) {
        const stockHistoryByAccount = await this.getStockHistory();

        const sortStockOperations = (a, b) => {
            if (a.date.getTime() === b.date.getTime())
                return a.operation === 'C' ? -1 : b.operation === 'C' ? 1 : 0;
            return a.date.getTime() - b.date.getTime();
        };

        const profitLoss = {};
        for (const account of stockHistoryByAccount) {
            const boughtQuantity = {};
            const boughtValue = {};

            for (const stockOperation of account.stockHistory.sort(sortStockOperations)) {
                if (endDate !== null && stockOperation.date > endDate) break;

                const code = StockUtils.getStockCode(stockOperation.code);
                if (!boughtQuantity[code]) boughtQuantity[code] = 0;
                if (!boughtValue[code]) boughtValue[code] = 0;
                if (!profitLoss[code]) profitLoss[code] = 0;

                if (stockOperation.operation === 'C') {
                    boughtQuantity[code] += stockOperation.quantity;
                    boughtValue[code] += stockOperation.quantity * stockOperation.price;
                } else if (stockOperation.operation === 'V' && (startDate === null || stockOperation.date >= startDate)) {
                    const averageBuyPriceSoFar = boughtQuantity[code] === 0 ? 0 : boughtValue[code] / boughtQuantity[code];
                    profitLoss[code] += stockOperation.quantity * stockOperation.price - stockOperation.quantity * averageBuyPriceSoFar;
                }
            }
        }

        return profitLoss;
    }

    async getKpis(startDate = null, endDate = null) {
        const profitLoss = await this.getProfitLoss(startDate, endDate);
        const stockHistory = (await this.getStockHistoryOperations())
            .filter(o => (startDate === null || o.date >= startDate) && (endDate === null || o.date <= endDate));

        return [
            {
                label: 'Compra',
                value: -stockHistory.filter(o => o.operation === 'C').reduce((p, c) => p + c.quantity * c.price, 0),
                quantity: stockHistory.filter(o => o.operation === 'C').reduce((p, c) => p + c.quantity, 0)
            },
            {
                label: 'Venda',
                value: stockHistory.filter(o => o.operation === 'V').reduce((p, c) => p + c.quantity * c.price, 0),
                quantity: stockHistory.filter(o => o.operation === 'V').reduce((p, c) => p + c.quantity, 0)
            },
            {
                label: 'Lucro/Prejuízo na Venda',
                value: Object.values(profitLoss).reduce((p, c) => p + c, 0)
            }
        ];
    }

    async deleteStockOperation(id) {
        const stockHistory = await this.getStockHistory();

        accountLoop:
        for (const account of stockHistory) {
            for (let i = 0; i < account.stockHistory.length; i++) {
                const stockOperation = account.stockHistory[i];
                if (stockOperation.id === id) {
                    account.stockHistory.splice(i, 1);
                    break accountLoop;
                }
            }
        }

        this.saveStockHistory(stockHistory, true);
    }

    async updateStockOperation(stockOperation) {
        const stockHistory = await this.getStockHistory();

        searchId:
        for (const account of stockHistory) {
            if (account.account === stockOperation.account && account.institution === stockOperation.institution) {
                for (let i = 0; i < account.stockHistory.length; i++) {
                    if (account.stockHistory[i].id === stockOperation.id) {
                        delete stockOperation.account;
                        delete stockOperation.institution;
                        stockOperation.source = account.stockHistory[i].source;
                        account.stockHistory[i] = stockOperation;
                        break searchId;
                    }
                }
            }
        }

        this.saveStockHistory(stockHistory, true);

        return stockOperation;
    }

    async createStockOperation(stockOperation) {
        const stockHistory = await this.getStockHistory();
        let found = false;
        stockOperation.source = 'Manual';
        stockOperation.id = StockUtils.generateId(stockOperation, stockOperation.account);
        let result = { ...stockOperation };
        for (const account of stockHistory) {
            if (account.account === stockOperation.account && account.institution === stockOperation.institution) {
                for (const s of account.stockHistory) {
                    if (s.id === stockOperation.id)
                        throw new Error('Operação já existente');
                }

                const copyStockOperation = { ...stockOperation };
                delete copyStockOperation.account;
                delete copyStockOperation.institution;
                account.stockHistory.push(copyStockOperation);
                found = true;
            }
        }

        if (!found) {
            const newAccount = {
                account: stockOperation.account,
                institution: stockOperation.institution
            };

            delete stockOperation.account;
            delete stockOperation.institution;
            newAccount.stockHistory = [stockOperation];
            stockHistory.push(newAccount);
        }

        this.saveStockHistory(stockHistory, true);

        return result;
    }

    async saveFromCsv(operations) {
        const data = await this.getStockHistory();

        for (let operation of operations) {
            const operationCopy = { ...operation, source: 'Manual' };
            const id = StockUtils.generateId(operationCopy, operationCopy.account);

            operationCopy['id'] = id;
            delete operationCopy['institution'];
            delete operationCopy['account'];
    
            const account = data.first(o => o.institution === operation.institution && o.account === operation.account);
            if (account) {
                const alreadyExists = account.stockHistory.first(o => o.id === id);
                if (alreadyExists) {
                    alreadyExists.quantity = operation.quantity;
                    alreadyExists.source = 'Manual';
                }
                else
                    account.stockHistory.push(operationCopy)
            } else {
                data.push({
                    institution: operation.institution,
                    account: operation.account,
                    stockHistory: [operationCopy]
                });
            }
        }

        await this.saveStockHistory(data, true);
    }

    async refreshHistory() {
        await this.updateStockHistoryJobMetadata(null);

        // Clearing history
        const stockHistory = await this.getStockHistory();
        stockHistory.forEach(acc => {
            acc.stockHistory = acc.stockHistory.filter(o => o.source && o.source !== 'CEI');
        });
        await this.saveStockHistory(stockHistory, true);

        new UpdateStockHistoryJob().run();
    }

    async splitOperations(splitConfig) {
        const stockHistory = await this.getStockHistory();

        const limitDate = new Date(splitConfig.date);
        const ratio = splitConfig.from / splitConfig.to;
        let splitted = 0;
        for (const account of stockHistory) {
            for (let i = 0; i < account.stockHistory.length; i++) {
                const operation = account.stockHistory[i];
                const operationDate = new Date(operation.date);

                if (operation.code === splitConfig.code && operationDate <= limitDate) {
                    operation.quantity = Math.floor(operation.quantity / ratio);
                    operation.price = Math.round((operation.price * ratio + Number.EPSILON) * 100) / 100;
                    splitted++;
                }
            }
        }

        this.saveStockHistory(stockHistory, true);
        return splitted;
    }

    async downloadCsv() {
        const savePath = await dialog.showSaveDialog({ defaultPath: 'stoincs-negociacoes.csv' });
        if (!savePath.canceled) {
            const data = await this.getStockHistoryOperations();
            await CsvUtils.saveCsv(savePath.filePath, data, CSV_HEADERS);
        }
    }

    async uploadCsv() {
        const openPaths = await dialog.showOpenDialog({ filters: [{ name: 'csv', extensions: ['csv'] }]});
        if (!openPaths.canceled) {
            let lines = 0;
            for (const path of openPaths.filePaths) {
                const data = await CsvUtils.readCsv(path, CSV_HEADERS);
                await this.saveFromCsv(data);
                lines += data.length
            }
            return lines;
        } else {
            return -1;
        }
    }

}

export default new StockHistoryService();
export { FILES as StockHistoryFiles };
