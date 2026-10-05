"use strict";

/**
 * ============================================================
 * ASSESSMENT SCOPE
 * ============================================================
 *
 * Decides which discovered objects go to the AI assessment and shows the
 * "funnel" (how many remain after each filter) BEFORE anything is sent.
 *
 * Pure function - no database or network access.
 *
 * Input objects (from SourceAdapter.discoverObjects()):
 *   { objectName, objectType, description, attributes }
 *
 * Rule sets are per source type (S4, M3). A new source (e.g. Oracle) adds
 * a rule set here and nothing else changes.
 *
 * Output:
 *   discovered   number of discovered objects
 *   steps        [{ id, label, remaining }]      the funnel
 *   candidates   [{ name, description, members }] one entry per assessable unit
 *   excluded     [{ name, reason }]
 */

const DEFAULT_OPTIONS = {
    scopePrefixes: [],       // M3: program name prefixes (areas), S/4: service name prefixes
    includeCustom: false,    // M3: include company-built programs (EXT...)
    readOnly: true,          // M3: only programs that can READ data (Lst/Get)
    businessApisOnly: true   // S/4: only business APIs (released / WEB_API)
};

const READ_TRANSACTION = /^(Lst|Get|Sel)/i;
const WRITE_TRANSACTION = /^(Add|Upd|Chg|Del|Cpy|Rmv|Set|Crt)/i;

const clean = (value) => String(value || "").trim();

const normalizePrefixes = (prefixes) =>
    (Array.isArray(prefixes) ? prefixes : String(prefixes || "").split(/[\s,;]+/))
        .map(prefix => clean(prefix).toUpperCase())
        .filter(Boolean);

/**
 * Applies filters one after the other and records the funnel.
 * filter(item) -> null to keep, or a reason string to exclude.
 */
function runFunnel(items, filters) {
    const steps = [{ id: "discovered", label: "Discovered in the system", remaining: items.length }];
    const excluded = [];
    let current = items;

    for (const { id, label, enabled, test } of filters) {
        if (!enabled) {
            continue;
        }

        const kept = [];

        for (const item of current) {
            const reason = test(item);

            if (reason) {
                excluded.push({ name: item.name, reason: `${label}: ${reason}` });
            } else {
                kept.push(item);
            }
        }

        current = kept;
        steps.push({ id, label, remaining: current.length });
    }

    return { steps, kept: current, excluded };
}

/**
 * ------------------------------------------------------------
 * S/4HANA: one unit = one OData service
 * ------------------------------------------------------------
 */
function scopeS4(objects, options) {
    const prefixes = normalizePrefixes(options.scopePrefixes);

    const items = objects.map(object => ({
        name: clean(object.objectName),
        description: object.description || null,
        attributes: object.attributes || {},
        members: [clean(object.objectName)]
    }));

    const { steps, kept, excluded } = runFunnel(items, [
        {
            id: "business-apis",
            label: "Business APIs only",
            enabled: options.businessApisOnly,
            test: (item) => {
                const { releaseStatus, serviceType } = item.attributes;

                // Release status is used when the catalog provides it
                if (releaseStatus) {
                    return String(releaseStatus).toUpperCase() === "RELEASED" ? null : `release status ${releaseStatus}`;
                }

                // otherwise: business APIs are WEB_API services or follow the API_ naming
                if (serviceType) {
                    return String(serviceType).toUpperCase() === "WEB_API" ? null : `service type ${serviceType}`;
                }

                return /^API_/i.test(item.name) ? null : "not an API_* service";
            }
        },
        {
            id: "scope",
            label: "In scope (name prefixes)",
            enabled: prefixes.length > 0,
            test: (item) => prefixes.some(prefix => item.name.toUpperCase().startsWith(prefix)) ? null : "name not in the scope list"
        }
    ]);

    return { steps, candidates: kept, excluded };
}

/**
 * ------------------------------------------------------------
 * M3: one unit = one MI program (all its transactions together)
 * object names are "PROGRAM.TRANSACTION"
 * ------------------------------------------------------------
 */
function scopeM3(objects, options) {
    const prefixes = normalizePrefixes(options.scopePrefixes);
    const programs = new Map();

    for (const object of objects) {
        const [program, transaction = ""] = clean(object.objectName).split(".");

        if (!programs.has(program)) {
            programs.set(program, {
                name: program,
                description: (object.description || "").split(" - ")[0] || null,
                transactions: [],
                members: [],
                programLevel: false
            });
        }

        // an object without a transaction is a program on its own (its transactions are read later, per business object)
        if (transaction) {
            programs.get(program).transactions.push(transaction);
        } else {
            programs.get(program).programLevel = true;
        }

        programs.get(program).members.push(clean(object.objectName));
    }

    const items = [...programs.values()];
    const transactionCount = objects.filter(object => clean(object.objectName).includes(".")).length;

    const { steps, kept, excluded } = runFunnel(items, [
        {
            id: "mi-programs",
            label: "MI programs only",
            enabled: true,
            test: (item) => /MI$/i.test(item.name) ? null : "not an MI (API) program"
        },
        {
            id: "read",
            label: "Read transactions only (Lst/Get)",
            enabled: options.readOnly,
            test: (item) => item.programLevel || item.transactions.some(t => READ_TRANSACTION.test(t))
                ? null
                : `only write transactions (${item.transactions.filter(t => WRITE_TRANSACTION.test(t)).slice(0, 3).join(", ") || "none readable"})`
        },
        {
            id: "custom",
            label: "Without custom programs (EXT...)",
            enabled: !options.includeCustom,
            test: (item) => /^EXT/i.test(item.name) ? "custom program" : null
        },
        {
            id: "scope",
            label: "In scope (areas)",
            enabled: prefixes.length > 0,
            test: (item) => prefixes.some(prefix => item.name.toUpperCase().startsWith(prefix)) ? null : "area not in the scope list"
        }
    ]);

    steps[0].label = transactionCount > 0
        ? `Discovered in the system (${transactionCount} transactions in ${programs.size} programs)`
        : `Discovered in the system (${programs.size} programs)`;
    steps[0].remaining = programs.size;

    return { steps, candidates: kept, excluded };
}

const RULE_SETS = {
    S4: scopeS4,
    M3: scopeM3
};

/**
 * @param {string}   adapterType  S4 | M3
 * @param {Object[]} objects      adapter.discoverObjects()
 * @param {Object}   options      see DEFAULT_OPTIONS
 */
function buildScope(adapterType, objects, options = {}) {
    const rules = RULE_SETS[String(adapterType || "").toUpperCase()];

    if (!rules) {
        throw new Error(`No assessment scope rules for source type '${adapterType}'`);
    }

    const merged = { ...DEFAULT_OPTIONS, ...options };
    const result = rules(objects || [], merged);

    return {
        discovered: result.steps[0].remaining,
        steps: result.steps,
        candidates: result.candidates,
        excluded: result.excluded,
        options: { ...merged, scopePrefixes: normalizePrefixes(merged.scopePrefixes) }
    };
}

/**
 * Rough token estimate per candidate: ~4 characters per token.
 * fieldCounts: Map(name -> number of fields) for objects already discovered;
 * unknown objects use the per-source default.
 */
const DEFAULT_TOKENS = { S4: 2000, M3: 500 };
const TOKENS_PER_FIELD = 12;
const PROMPT_TOKENS_PER_BATCH = 3000;
const OUTPUT_TOKENS_PER_OBJECT = 120;

function estimateTokens(adapterType, candidates, fieldCounts = new Map(), batchSize = 11) {
    const type = String(adapterType || "").toUpperCase();
    let input = 0;

    for (const candidate of candidates) {
        const fields = candidate.members.reduce((sum, member) => sum + (fieldCounts.get(member) || 0), 0);

        input += fields > 0 ? fields * TOKENS_PER_FIELD : (DEFAULT_TOKENS[type] || 1000);
    }

    const batches = Math.ceil(candidates.length / Math.max(1, batchSize));

    return {
        inputTokens: input + batches * PROMPT_TOKENS_PER_BATCH,
        outputTokens: candidates.length * OUTPUT_TOKENS_PER_OBJECT,
        batches
    };
}

module.exports = {
    buildScope,
    estimateTokens,
    DEFAULT_OPTIONS
};
