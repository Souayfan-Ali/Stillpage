# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately. Do not open a public issue.

- Preferred channel: GitHub private vulnerability reporting on
  <https://github.com/Souayfan-Ali/Glassmere> (Security tab, "Report a vulnerability").
- Response target: an acknowledgement within **72 hours**.

Include the extension version, Chrome version, steps to reproduce and, if possible, a minimal page that
shows the problem.

## What happens next

1. We confirm the issue and prepare a fix privately.
2. The fix ships in an on-demand full release. A network-rule mitigation, where one exists, can ship the
   same day through a ruleset release.
3. An advisory is published after the Chrome Web Store has published the fixed version.
4. Anything that reached users gets a post-incident note in the repository.

## Scope

In scope: the extension package, its build and release tooling, and the filter-list compiler.
Out of scope: bugs in upstream filter lists (report those upstream), and Chrome itself.
