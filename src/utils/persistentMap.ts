import fs from 'node:fs';
import path from 'node:path';

export class PersistentStringMap {
    readonly #file: string;
    readonly #values: Map<string, string>;

    constructor(file: string) {
        this.#file = file;
        this.#values = this.#load();
    }

    get(key: string) {
        return this.#values.get(key);
    }

    set(key: string, value: string) {
        this.#values.set(key, value);
        this.#save();
    }

    delete(key: string) {
        if (this.#values.delete(key)) this.#save();
    }

    #load() {
        try {
            return new Map<string, string>(Object.entries(JSON.parse(fs.readFileSync(this.#file, 'utf8'))));
        } catch {
            return new Map<string, string>();
        }
    }

    #save() {
        fs.mkdirSync(path.dirname(this.#file), { recursive: true });
        const temporary = `${this.#file}.tmp`;
        fs.writeFileSync(temporary, `${JSON.stringify(Object.fromEntries(this.#values), null, 2)}\n`, { mode: 0o600 });
        fs.renameSync(temporary, this.#file);
        fs.chmodSync(this.#file, 0o600);
    }
}
