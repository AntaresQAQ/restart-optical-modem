import { stringify as stringifyQuery } from "querystring";
import { format as formatUrl } from "url";
import { readFileSync } from "fs";

interface IModemUtilOptions {
    username: string;
    password: string;
    ip: string;
    port?: number;
    protocol?: "http" | "https";
}

class ModemUtil {
    private readonly options: IModemUtilOptions;

    public constructor(options: IModemUtilOptions) {
        this.options = {
            ...options,
            protocol: options.protocol || "http",
            port: options.protocol === "https" ? 443 : 80,
        };
    }

    private async getFrmLoginToken() {
        const url = formatUrl({
            protocol: this.options.protocol,
            hostname: this.options.ip,
            port: this.options.port,
        });
        const response = await fetch(url, {
            method: "GET",
        });
        const html = await response.text();
        if (!html) {
            throw new Error("Get Frm_Logintoken failed: empty response.");
        }
        const frmt = html.match(/getObj\("Frm_Logintoken"\)\.value = "(.*)";/)[1];
        return frmt;
    }

    private async postLogin(frmLoginToken: string) {
        const url = formatUrl({
            protocol: this.options.protocol,
            hostname: this.options.ip,
            port: this.options.port,
        });
        const body = stringifyQuery({
            frashnum: "",
            action: "login",
            Frm_Logintoken: frmLoginToken,
            username: this.options.username,
            logincode: this.options.password,
            textpwd: "",
            ieversion: "1",
        });
        await fetch(url, {
            method: "POST",
            body,
        });
    }

    private async getSessionToken() {
        const url = formatUrl({
            protocol: this.options.protocol,
            hostname: this.options.ip,
            port: this.options.port,
            pathname: "/web/cmcc/gch/template_user.gch",
        });
        const response = await fetch(url, {
            method: "GET",
        });
        const html = await response.text();
        if (!html) {
            throw new Error("Get session_token failed: empty response.");
        }
        const token = html.match(/var session_token = "(.*)";/)[1];
        return token;
    }

    private async postRestart(sessionToken: string): Promise<void> {
        const query = stringifyQuery({
            pid: 1002,
            nextpage: "web/cmcc/gch/iot_advance_setting_t.gch",
        });

        const url = formatUrl({
            protocol: this.options.protocol,
            hostname: this.options.ip,
            port: this.options.port,
            pathname: "/web/cmcc/gch/getpage.gch",
            search: query,
        });

        const body = stringifyQuery({
            IF_ACTION: "devrestart",
            IF_ERRORSTR: "SUCC",
            IF_ERRORPARAM: "SUCC",
            IF_ERRORTYPE: "-1311313888",
            flag: "1",
            _SESSION_TOKEN_USER: sessionToken,
        });

        try {
            await fetch(url, {
                method: "POST",
                body,
                signal: AbortSignal.timeout(1000),
            });
        } catch {}
    }

    public async restart(): Promise<void> {
        const frmLoginToken = await this.getFrmLoginToken();
        await this.postLogin(frmLoginToken);
        const sessionToken = await this.getSessionToken();
        await this.postRestart(sessionToken);
    }
}

interface IAppConfig {
    username: string;
    password: string;
    ip: string;
    port?: number;
    protocol?: "http" | "https";
    checkingInterval: number;
    checkingUrl: string;
    expectedDelay: number;
    maxBadCount: number;
    badIncrease: number;
    goodReduce: number;
    restartEveryDayTime?: string;
    startDelay?: number;
}

class App {
    private readonly config: IAppConfig;
    private readonly modemUtil: ModemUtil;
    private readonly restartEveryDayDate: Date = null;

    private currentBadCount: number = 0;
    private checkingIntervalHandler: NodeJS.Timeout = null;

    private isRestarting: boolean = false;

    public constructor() {
        this.config = {
            ip: "192.168.1.1",
            username: "user",
            password: "000000",
            checkingInterval: 2000,
            checkingUrl: "https://www.baidu.com",
            expectedDelay: 800,
            maxBadCount: 10,
            badIncrease: 2,
            goodReduce: 1,
            ...this.readConfig(),
        };

        if (this.config.restartEveryDayTime) {
            this.restartEveryDayDate = this.parseDate(this.config.restartEveryDayTime);
        }

        this.modemUtil = new ModemUtil({
            username: this.config.username,
            password: this.config.password,
            ip: this.config.ip,
            port: this.config.port,
            protocol: this.config.protocol,
        });
    }

    private readConfig(): Partial<IAppConfig> {
        const configPath = process.env.RESTART_PON_CONFIG || "/etc/restart-pon.json";
        const configRaw = readFileSync(configPath, "utf8");
        return JSON.parse(configRaw) as unknown as Partial<IAppConfig>;
    }

    private parseDate(time: string): Date {
        const [hour, minute, second] = time.split(":").map((v) => Number.parseInt(v, 10));
        const date = new Date();
        date.setHours(hour);
        date.setMinutes(minute);
        if (second !== undefined) {
            date.setSeconds(second);
        } else {
            date.setSeconds(0);
        }
        date.setMilliseconds(0);
        return date;
    }

    private async checkingDelay(): Promise<number> {
        const startTime = Date.now();
        try {
            await fetch(this.config.checkingUrl);
        } catch {
            return Number.POSITIVE_INFINITY;
        }
        const endTime = Date.now();
        return endTime - startTime;
    }

    private checking() {
        return setInterval(async () => {
            if (this.isRestarting) {
                console.log("Checking restarting status...");
            }
            const delay = await this.checkingDelay();
            if (delay > this.config.expectedDelay) {
                if (this.isRestarting) {
                    console.log("Checked still restarting.");
                    return;
                }
                this.currentBadCount += this.config.badIncrease;
                console.log(
                    `Bad delay: ${delay}ms, excepted: ${this.config.expectedDelay}ms, count: ${this.currentBadCount}.`,
                );
                if (this.currentBadCount >= this.config.maxBadCount) {
                    this.currentBadCount = 0;
                    this.onBadChecked();
                }
            } else {
                if (this.isRestarting) {
                    this.isRestarting = false;
                    console.log("Restart successfully.");
                }
                if (this.currentBadCount > 0) {
                    this.currentBadCount -= this.config.goodReduce;
                    console.log(`Good delay: ${delay}ms, count: ${this.currentBadCount}.`);
                }
            }
        }, this.config.checkingInterval);
    }

    private onBadChecked() {
        this.stopChecking();
        this.restartModem().then(() => {
            this.startChecking();
        });
    }

    private stopChecking() {
        if (this.checkingIntervalHandler) {
            clearInterval(this.checkingIntervalHandler);
            this.checkingIntervalHandler = null;
            this.currentBadCount = 0;
            console.log("Checking stop.");
        }
    }

    private startChecking() {
        if (this.checkingIntervalHandler) {
            return;
        }
        console.log("Checking start.");
        this.checkingIntervalHandler = this.checking();
    }

    private async restartModem() {
        if (this.isRestarting) {
            return;
        }
        this.isRestarting = true;
        console.log("Restarting...");
        try {
            await this.modemUtil.restart();
        } catch (e) {
            console.error("Restart failed.");
            console.error(e);
            this.isRestarting = false;
        }
    }

    private registerRestartEveryDay() {
        if (!this.restartEveryDayDate) {
            return;
        }
        const now = new Date(Date.now());
        const nextRestartTime = new Date(now);
        nextRestartTime.setHours(this.restartEveryDayDate.getHours());
        nextRestartTime.setMinutes(this.restartEveryDayDate.getMinutes());
        nextRestartTime.setSeconds(this.restartEveryDayDate.getSeconds());
        nextRestartTime.setMilliseconds(0);
        if (nextRestartTime.getTime() <= now.getTime()) {
            nextRestartTime.setDate(nextRestartTime.getDate() + 1);
        }

        const diff = nextRestartTime.getTime() - now.getTime();

        console.log(`Next restart time: ${nextRestartTime.toLocaleString()}`);

        setTimeout(() => {
            this.stopChecking();
            this.restartModem().then(() => {
                this.startChecking();
            });
            this.registerRestartEveryDay();
        }, diff);
    }

    public run() {
        if (this.config.startDelay && this.config.startDelay > 0) {
            setTimeout(() => {
                this.startChecking();
                this.registerRestartEveryDay();
            }, this.config.startDelay);
        } else {
            this.startChecking();
            this.registerRestartEveryDay();
        }
    }
}

new App().run();
