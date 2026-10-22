import { globalIgnores } from "eslint/config";
// eslint-config-next 16 ships flat configs directly; the FlatCompat/eslintrc
// bridge used on Next 15 is gone.
import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const config = [
  globalIgnores([".next/**", "out/**", "node_modules/**", "next-env.d.ts"]),
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      // eslint-plugin-react-hooks@7 (pulled in by eslint-config-next@16) turns
      // on React-Compiler-era rules that did not exist in the previous config.
      // Complying with them means restructuring how every page loads data
      // (state set from `useEffect(() => { void load() })`, the post-mount
      // `publicUrl` read that needs `window`, and `Date.now()` in render),
      // which is the work tracked separately in issue #185 ("move page data
      // loading into hooks"). Downgraded to warn so the debt stays visible on
      // every lint run without blocking CI on an unrelated refactor; they can
      // be re-raised to error once #185 lands.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
    },
  },
];

export default config;
