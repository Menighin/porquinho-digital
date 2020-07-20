import { BrowserWindow } from 'electron';
import StockPriceService from '../services/StockPriceService';
import ConfigurationService from '../services/ConfigurationService';
import NotificationService from '../services/NotificationService';

class UpdatePricesJob {

    /** @type {BrowserWindow} */
    _browserWindow;

    /** @type { when: Number, many: Number} */
    _configuration;

    /** @type {String[]} */
    _stocks;

    _interval;

    _updateSlice = [];

    /**
     * Setup the job
     * @param {BrowserWindow} browserWindow Browser window to be notified
     */
    async setup(browserWindow) {
        this._browserWindow = browserWindow;

        await this.init();
        
        console.log('WAAAAT' + JSON.stringify(this._configuration));
        if (this._configuration && this._configuration.when > 0) {
            setTimeout(() => {
                this.run();
                this._interval = setInterval(() => { this.run() }, this._configuration.when * 1000 * 60);
            }, 15000);
        }
    }

    async init() {
        this._configuration = (await ConfigurationService.getConfiguration()).priceUpdate || {};
        this._stocks = Object.keys((await StockPriceService.getStockPrices()) || {}).sort();
    }

    async run() {
        if (!this._configuration.auto) {
            NotificationService.notifyMessage('Preços não atualizados', 'A atualização automática de preços está desligada', 'fas fa-coins');
            return;
        }

        const totalToUpdate = this._stocks.length;

        if (this._stocks.length === 0) return;

        if (this._updateSlice.length === 0 || this._updateSlice[1] >= totalToUpdate) {
            this._updateSlice = [0, this._configuration.many];
        } else {
            this._updateSlice[0] = this._updateSlice[1];
            this._updateSlice[1] = Math.min(this._updateSlice[1] + this._configuration.many, totalToUpdate);
        }

        const stocks = this._stocks.slice(this._updateSlice[0], this._updateSlice[1]);

        this._browserWindow.webContents.send('stock-prices/updating', { data: stocks });
        NotificationService.notifyLoadingStart('updating-prince', 'Atualizando preços');

        try {
            const result = await StockPriceService.autoUpdateStockPrices(stocks);
            this._browserWindow.webContents.send('stock-prices/auto-update', { data: result });

            NotificationService.notifyMessage('Preços atualizados', stocks.join(', '), 'fas fa-coins');
        } catch (e) {
            NotificationService.notifyMessage('Falha ao atualizar preços', e.getMessage(), 'fas fa-coins');
        }
        NotificationService.notifyLoadingFinish('updating-prince');
    }

    async updateConfig() {
        clearInterval(this._interval);
        await this.init();

        console.log(`Updating prices job to run every ${this._configuration.when} minute(s)`);
        if (this._configuration.when > 0)
            this._interval = setInterval(() => { this.run() }, this._configuration.when * 1000 * 60);
    }

    inWorkingHours() {
        const now = new Date();

        const [h1, m1] = this._configuration.startTime.split(':').map(o => parseInt(o));
        const [h2, m2] = this._configuration.endTime.split(':').map(o => parseInt(o));

        const d1 = new Date();
        d1.setHours(h1);
        d1.setMinutes(m1);

        const d2 = new Date();
        if (h2 < h1 || (h2 === h1 && m2 < m1))
            d2.setTime(d2.getTime() + 1000 * 60 * 60 * 24);
        d2.setHours(h2);
        d2.setMinutes(m2);

        return now.getTime() >= d1.getTime() && now.getTime() <= d2.getTime();
    }

}

export default new UpdatePricesJob();
