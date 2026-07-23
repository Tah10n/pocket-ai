## Summary

Describe the problem and the change in a few sentences.

## Related issue

Link the issue this pull request addresses, if one exists.

## What changed

- 

## Verification

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run verify:mobile-change`
- [ ] `npm run verify:mobile-change:android` if Android behavior or visible UI changed

## Optional checks

- [ ] Run Android checks
- [ ] Run Android scenarios

Optional Android QA pack labels (CI priority when multiple labels are present): `android-pack-all`, `android-pack-branch-regeneration`, `android-pack-native`, `android-pack-runtime`, `android-pack-dependency-ui`, `android-pack-catalog`, then `android-pack-extended`.

`android-pack-branch-regeneration` runs the destructive 15-step release pack fail-closed on the dedicated ephemeral prepared runner. It requires a disposable same-signature device, a loaded local model, and the fixture plus sentinel conversations; missing preconditions fail CI and a successful run consumes the fixture.

## UI evidence

Add screenshots or recordings for visible UI changes.

## Checklist

- [ ] PR title follows Conventional Commits (`feat:`, `fix:`, `docs:`, ...)
- [ ] The change is focused on one logical improvement
- [ ] Documentation was updated if public behavior or setup changed
- [ ] Translation keys were updated in `src/i18n/locales/en.json` and `src/i18n/locales/ru.json` for new user-facing copy
- [ ] Risks, limitations, or follow-up work are called out below

## Risks and follow-ups

- 
