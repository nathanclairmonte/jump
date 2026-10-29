# Contributing to Jump

Jump is a personal project maintained by Nathan Clairmonte. Bug reports and focused
pull requests are welcome. There is no guaranteed response time or commitment to
accept feature requests.

## Report a bug

Search the [existing issues](https://github.com/nathanclairmonte/jump/issues) first.
Include your Jump version, operating system, editor, reproduction steps, and the
result you expected. For WSL problems, include the distribution and WSL version.
Remove credentials and private project information from logs and screenshots.

For security problems, follow [the security policy](SECURITY.md).

## Propose a change

Open an issue before starting a substantial feature or architectural change.
Keep each pull request focused on one problem. Explain the user-visible change
and how you verified it. Include screenshots for interface changes.

Follow the [development instructions](README.md#develop). Run the native app on
the operating system affected by your change. The browser demo uses mock data
and does not verify native scanning or editor launching.

From the repository root, run the checks relevant to your change:

```sh
task check
bun run test
bun run build
cargo test --manifest-path src-tauri/Cargo.toml -p jump-core
```

For website changes, install its separate dependencies with
`npm ci --prefix website`, then run `task check-web`.

Use lowercase conventional commit messages without a body. Write comments that
explain a non-obvious reason, rather than narrating the code.

## License

Contributions are licensed under the project's [MIT license](LICENSE).
