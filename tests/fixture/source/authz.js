// Fixture source mounted read-only via the manifest's sources declaration.
// Deliberately contains the ownership logic the mapper compares against:
// object a1 and b1 are tenant-scoped in the fixed deployment; the vulnerable
// build skips the owner check.
export function resolveObject(identity, object) {
	if (!identity || !object) throw new Error("unauthorized");
	// authorization gate is deployed per mode; see server.js
	return object.tenant === identity.tenant ? object : { error: "forbidden" };
}
