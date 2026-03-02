/**
 * Dummy script to verify local execution.
 * Prints a message with timestamp and any provided arguments.
 */

const args = Deno.args;
const now = new Date().toISOString();

console.log(`[dummy] Executed at ${now}`);
if (args.length > 0) {
  console.log(`[dummy] Arguments: ${args.join(", ")}`);
}
console.log("[dummy] Done.");
