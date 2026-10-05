const SyntheticSourceAdapter =
    require("./SyntheticSourceAdapter");

const S4SourceAdapter =
    require("./S4SourceAdapter");

const M3SourceAdapter =
    require("./M3SourceAdapter");

const adapters = {
    SYNTHETIC: SyntheticSourceAdapter,
    S4: S4SourceAdapter,
    M3: M3SourceAdapter
};

function createSourceAdapter(connection) {

    const adapterType =
        (connection.adapterType || "").toUpperCase();

    const AdapterClass =
        adapters[adapterType];

    if (!AdapterClass) {
        throw new Error(
            `No source adapter is currently available for '${connection.adapterType}'`
        );
    }

    return new AdapterClass(connection);
}

module.exports = {
    createSourceAdapter
};