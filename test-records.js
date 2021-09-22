const ajv = new (require('ajv'))({ verbose: true });
const fs = require('fs');
const glob = require('glob');
const path = require('path');
const countries = require('countries-list').countries;
const cities = require('all-the-cities');

const autofix = process.argv[2] === '--auto-fix'; // TODO do more sophisticated parsing if we need more options

// json-forms uses the `text` format for multi-line strings.
ajv.addFormat('text', (a) => true);
// ajv doesn't support the `idn-email` format. As validation of email addresses isn't exactly critical for us, we'll
// just use this *very* basic check.
ajv.addFormat('idn-email', /^\S+@\S+\.\S+$/);

const cdb_schema = ajv.compile(JSON.parse(fs.readFileSync('schema.json').toString()));
const adb_schema = ajv.compile(JSON.parse(fs.readFileSync('schema-supervisory-authorities.json').toString()));

const country_name_variations = ['United States of America', 'The Netherlands', 'Republic of Singapore'];
const variation_countrycodes = ['US', 'NL', 'SG'];

const templates = glob.sync('**/*.txt', { cwd: 'templates' }).reduce((acc, cur) => {
    const [lang, name] = cur.replace('.txt', '').split('/');
    if (acc[lang]) acc[lang].push(name);
    else acc[lang] = [name];
    return acc;
}, {});

/**
 * @typedef {Object} TestEvent
 * @property {('error'|'autofix')} type
 * @property {string} msg - a message for the user
 * @property {string} ref - a URL as reference
 * @property {Object} error - an error object
 **/

const print = (events) => {
    for (let file in events) {
        if (!events[file] || events[file].length === 0) continue;
        console.error(/* bold, bg red */ `\x1b[1m\x1b[41mError(s) in ${file}:\x1b[0m` /* reset */);
        events[file].forEach((/** @type TestEvent*/ event) => {
            if (event.msg && Object.keys(event).length === 1) {
                console.error(event.msg);
            } else if (event.msg) {
                const { msg, ...stuff } = event;
                console.error(msg, stuff);
            } else {
                console.error(event);
            }
        });
    }
};

const validator = (dir, schema, additional_checks = null) => {
    /** @type {Object.<string, Array.<TestEvent>>*/
    let events = {};
    const files = glob.sync(`${dir}/*.json`);

    files.forEach((f) => {
        /** @param {TestEvent} ev */
        const add_event = (ev) => {
            if (!events[f]) events[f] = [];
            events[f].push(ev);
        };

        const file_content = fs.readFileSync(f).toString();
        if (!file_content.toString().endsWith('}\n'))
            add_event({ msg: "File doesn't end with exactly one newline.", type: 'error' });

        let json;
        try {
            json = JSON.parse(file_content);
        } catch (err) {
            add_event({ msg: 'Parsing JSON failed.\n', error: err, type: 'error' });
            // if parsing failed we can't do any content-related checks, we skip to the next file.
            return;
        }
        if (!schema(json)) add_event({ msg: 'Schema validation failed.\n', error: schema.errors, type: 'error' });
        if (json.slug + '.json' !== path.basename(f)) {
            add_event({ msg: `Filename "${path.basename(f)}" does not match slug "${json.slug}".`, type: 'error' });
        }
        if (additional_checks) {
            const tmp = additional_checks(json, f);
            events[f] = events[f] ? events[f].concat(tmp) : tmp;
        }
    });
    print(events);
};

function isLastLineCountry(last_line, country_name_variations = []) {
    return (
        Object.entries(countries).some(
            ([countrycode, v]) =>
                (!variation_countrycodes.includes(countrycode) && v.name == last_line) || v.native == last_line
        ) || country_name_variations.includes(last_line)
    );
}
/**
 *
 * @param {Object} json
 * @param {string} f
 * @returns {Array.<TestEvent>}
 */
function additional_checks(json, f) {
    let af_json = JSON.parse(JSON.stringify(json));
    /** @type {Array.<TestEvent>} */
    let errors = [];
    /** @type {Array.<TestEvent>} */
    let autofixes = [];
    // Check for necessary `name` field in the required elements (#388).
    if (json['required-elements']) {
        const has_name_field = json['required-elements'].some((el) => el.type === 'name');
        if (!has_name_field)
            errors.push({
                msg: `Record has required elements but no 'name' element.`,
                ref: 'https://github.com/datenanfragen/data#required-elements',
            });
    }

    for (const prop of [
        'custom-access-template',
        'custom-erasure-template',
        'custom-rectification-template',
        'custom-objection-template',
    ]) {
        // If a record specifies a `custom-*-template` without also specifying a `request-language`, the template _must_
        // at least be available in English and _should_ also be available in the other languages (#1120).
        if (json[prop]) {
            if (json['request-language']) {
                if (!templates[json['request-language']].includes(json[prop]))
                    errors.push({
                        msg: `Record specifies '${prop}' of '${json[prop]}' but that isn't available for 'request-language' of '${json['request-language']}'.`,
                    });
            } else {
                if (!templates['en'].includes(json[prop]))
                    errors.push({
                        msg: `Record specifies '${prop}' of '${json[prop]}' but that isn't available in English.`,
                        ref: 'https://github.com/datenanfragen/data/issues/1120',
                    });
            }
        }
    }

    // A `quality` of `tested` may only be set if `required-elements` are specified (#811).
    if (json['quality'] === 'tested') {
        if (!json['required-elements'])
            errors.push({
                msg: "Record has `quality` of `tested` but doesn't specify `required-elements`.",
                ref: 'https://github.com/datenanfragen/data/issues/811',
            });
    }
    // whitespace check
    Object.keys(json).forEach((key) => {
        if (typeof json[key] === 'string' && json[key] !== json[key].trim()) {
            errors.push({
                msg: `Seems like \`${key}\` isn't trimmed, i.e. it contains leading or trailing whitespace.`,
            });
            if (autofix) {
                af_json[key] = json[key].trim();
                autofixes.push({ msg: `trimmed ${key}` });
            }
        }
    });

    // address formatting
    const address_lines = json['address'].split('\n');
    if (address_lines.length < 2) errors.push({ msg: '`address` is not formatted with newlines (\\n).' });

    if (address_lines.some((line) => line !== line.trim())) {
        errors.push({ msg: "`address` isn't trimmed (linewise), i.e. it contains unnecessary whitespace." });
        if (autofix) {
            af_json['address'] = address_lines.map((x) => x.trim()).join('\n');
            autofixes.push({ msg: 'trimmed address' });
        }
    }

    if (address_lines.includes(json['name'])) errors.push({ msg: 'Record includes `name` in the `address`.' });
    if (autofix && address_lines[0].trim() === json['name']) {
        af_json['address'] = address_lines.slice(1).join('\n');
        autofixes.push({ msg: 'Removed duplicate name in first line of address' });
    }

    // check if the last line is a country
    // this test might produce false-positives, as it's a difficult thing to do
    // we might consider more fuzzy matching if we get many reports of false positives

    const last_line = address_lines[address_lines.length - 1].trim();
    const last_line_is_country = isLastLineCountry(last_line, country_name_variations);

    if (!last_line_is_country) {
        errors.push({
            msg: `Last line of \`address\` (${last_line}) should be a country. If you feel like this error is a mistake, please let us know! We get our list of countries from https://www.npmjs.com/package/countries-list. We've decided on specific variations for some countries: (${country_name_variations.join(
                ', '
            )}).`,
        });
        if (autofix) {
            const city = /[\d ]* ([\S ]*)/.exec(last_line)[1]; // TODO make this smarter, i.e. make it work with more formats
            const guess = cities.filter((x) => x.name === city)[0];
            if (guess) {
                af_json.address += `\n${
                    variation_countrycodes.includes(guess.country)
                        ? country_name_variations[variation_countrycodes.indexOf(guess.country)]
                        : countries[guess.country].name
                }`;
                autofixes.push({ msg: `guessed missing country: ${guess.country}` });
            }
        }
    }
    if (autofix && json !== af_json) fs.writeFileSync(f, JSON.stringify(af_json, null, 4) + '\n'); // TODO add replacer for re-ordering, see suggest in website

    /**
     * re-use when we've implemented warnings, this shouldn't be a hard fail
     *
    // set suggested-transport-medium if email is privacy related
    // TODO: extend the regex
    if (/(privacy|dpo|dsb|datenschutz|gdpr|dsgvo).*@/.test(json['email'])) {
        if (json['suggested-transport-medium'] !== 'email')
            errors.push(
                'Record sets `email` to a privacy-related address, but doesn\'t set suggested-transport-medium": "email".'
            );
    }
     */
    /**@type Array.<TestEvent> */
    let returnevents = [];
    for (const a of autofixes) returnevents.push({ ...a, type: 'autofix' });
    for (const e of errors) returnevents.push({ ...e, type: 'error' });
    return returnevents;
}
validator('companies', cdb_schema, additional_checks);
validator('supervisory-authorities', adb_schema);
