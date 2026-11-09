# Licensing

CrewRouter and all SDK packages in this repository are **GPL-3.0**. This includes:

- The Node/TypeScript client SDK (`sdk/typescript`)
- The Python client SDK (`sdk/python`)
- The Go client SDK (`sdk/go`)
- The embedded server SDK (`crewrouter/embedded`, preview)

There is no separate MIT/Apache license for the SDK packages. Each package
contains a copy of the GPL-3.0 license text.

## What this means in practice

- You may use, modify and distribute the SDKs under GPL-3.0.
- If you distribute a work based on the SDKs, the work must be licensed under
  GPL-3.0 and you must make the corresponding source available.
- Using an SDK to call a CrewRouter instance over the network does not by itself
  change the license of the calling application. Distribution and derivative-work
  questions are fact-specific.
- The **embedded** SDK links the CrewRouter server code into the host process.
  Distributing that combined application triggers GPL-3.0 obligations for the
  combined work.
- The GPL applies to the code, not to the model outputs you generate.

This page is a summary, not legal advice. Review the full
[LICENSE](../../LICENSE) and consult counsel before distributing a product that
embeds CrewRouter.

## Server-side data and privacy

The SDK does not report usage to the CrewRouter project. The instance may have
anonymous aggregate stats reporting enabled by the administrator; see the root
[README](../../README.md#统计信息上报可选).
