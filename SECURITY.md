# Security

## Reporting a vulnerability

Please email **wind2sp@9rowpar.com** with the subject "Omniweave security" and describe the issue and how to reproduce it (the file type and, if you can, a sample file that triggers it). Do not open a public issue for security problems. We aim to reply within 7 days.

보안 문제는 공개 이슈 대신 **wind2sp@9rowpar.com**으로 알려 주세요(제목: "Omniweave security"). 문제가 생기는 파일 형식과, 가능하면 재현 파일을 함께 보내 주세요.

## What Omniweave does and does not do

- Files are opened and saved on your computer only. The app sends no usage data, has no account and no cloud storage.
- The desktop installer and portable exe check GitHub Releases for updates and install an update only after verifying its signature (minisign, the public key is built into the app). The Microsoft Store version is updated by the Store.
- Opening untrusted files is the main risk area: Omniweave parses many complex formats (DOCX, HWP/HWPX, PDF, PSD, AI, DWG/DXF and more). Parsers are written to fail safely on damaged or hostile input, but please report any file that crashes or hangs the app.
- The Windows builds are not Authenticode-signed yet. Download only from https://github.com/wind2sp/omniweave/releases or the Microsoft Store and compare the SHA-256 in SHA256SUMS.txt.

## Supported versions

Security fixes go into the latest release.
