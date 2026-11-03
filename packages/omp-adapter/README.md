# OMP adapter

Launch OMP from the HackHarness checkout with the extension explicitly trusted:

```sh
export HH_MANIFEST="$PWD/examples/local-fixture.json"
export HH_DATA_DIR="$PWD/.hackharness-data"
export HH_TOKEN_A='fixture-token-a'
export HH_TOKEN_B='fixture-token-b'
omp --trusted-extension "$PWD/packages/omp-adapter/index.ts"
```

The extension registers `/hh` plus five typed tools. It invokes the local coordinator CLI using argument arrays, never a shell. All target requests still pass through the gateway; the extension does not receive credential values.

For untrusted repositories, start OMP outside their checkout and use an explicit trusted-extension allowlist. Do not copy this adapter into a target repository.
