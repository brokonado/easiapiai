// The client version. Kept equal to the Python client's __version__ and to package.json (a test checks both).
export const VERSION = "0.2.0";

// Sent as "client" with test answers and used as the User-Agent. The Python client sends "easiapiai-cli/<version>";
// this one says it is the Node client.
export const CLIENT = "easiapiai-cli-node/" + VERSION;
