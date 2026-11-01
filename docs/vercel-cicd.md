# Vercel Deploy Guide

Tai lieu nay dung de tu kiem tra va deploy lai project len Vercel moi khi co thay doi.

## Thong tin project

- Vercel project: `bitter-melon-annotation`
- Production URL: <https://bitter-melon-annotation.vercel.app>
- Root directory tren Vercel: `annotation-tool`
- Framework: Next.js
- Build command local tu repository root: `npm run build`

File link project local nam o:

```powershell
.vercel\project.json
```

Project hien dang dung:

```json
{
  "projectId": "prj_LyuHOCjx00P1rRcQyvoKQ7ixHri8",
  "orgId": "team_4YaaqzZm7ypCsPIvpdndHZze"
}
```

## Deploy thu cong

Chay cac lenh tu repository root:

```powershell
cd F:\ANHTHU\1-HCMUS\0-KLTN\SEGMENT\SAM\khoqua-mask-editor-react\khoqua-mask-editor-react
```

Kiem tra build truoc:

```powershell
npm run build
```

Neu build pass, deploy production:

```powershell
npx vercel@latest --prod --yes
```

Tu 2026-10-25: repo root co `.vercelignore` (bo `drive/`, `annotation-tool/artifacts/`, `.env*`, du lieu local). Khong co file nay CLI tai len >1 GB va bao `Upload aborted`. Lenh da dung: `npx vercel@latest --prod --yes --archive=tgz`.

Sau khi deploy thanh cong, Vercel CLI se in ra:

- `Production`: URL deployment rieng cua lan deploy do
- `Aliased`: URL production chinh, thuong la <https://bitter-melon-annotation.vercel.app>
- `readyState`: phai la `READY`

## Khi Vercel CLI bao version cu

Neu gap loi dang:

```text
Your Vercel CLI version is outdated. This endpoint requires version 47.2.2 or later.
```

Dung lenh nay thay cho `npx vercel`:

```powershell
npx vercel@latest --prod --yes
```

Khong can cai global neu chi muon deploy nhanh.

## Kiem tra sau deploy

Mo production URL:

```text
https://bitter-melon-annotation.vercel.app
```

Nen kiem tra nhanh:

- Trang login mo duoc.
- API health mo duoc: `https://bitter-melon-annotation.vercel.app/api/health`
- So `fingerprints.database` va `fingerprints.blobStore` voi `http://localhost:3000/api/health`. Ca hai phai trung thi localhost moi ghi vao cung database **va** cung kho Blob voi production. `.env.local` tao boi `vercel env pull` la bien moi truong Development; neu Blob fingerprint khac, mask upload tu localhost se khong doc duoc tren production.
- Dung chung database nghia la thao tac thu o localhost (khoa file, luu, dat ban chinh) anh huong truc tiep du lieu that.
- Cac tinh nang can database/blob/Google Drive chay dung voi env production.

Neu muon xem chi tiet deployment:

```powershell
npx vercel@latest inspect bitter-melon-annotation.vercel.app
```

## Environment variables

Vercel co the canh bao neu phat hien file `.env`. Cach tot nhat la dat bien moi truong trong:

```text
Vercel -> Project Settings -> Environment Variables
```

Candidate bien toi thieu thuong can:

- `SECRET_KEY`
- `DATABASE_URL` hoac `POSTGRES_URL` / `NEON_DATABASE_URL`
- `BLOB_READ_WRITE_TOKEN` neu dung Vercel Blob

Bien Google Drive/OAuth chi can them neu bat tinh nang tuong ung.

Khong nen commit secret that len Git.

## GitHub Actions CI/CD

Workflow nam o:

```text
.github/workflows/vercel.yml
```

Y nghia:

- Pull request vao `master`: chay test/typecheck/build va tao Preview Deployment.
- Push hoac merge vao `master`: chay test/typecheck/build va deploy Production.
- `workflow_dispatch`: cho phep chay Production thu cong tu GitHub Actions.

## GitHub Secrets cho CI/CD

Them repository secrets tai:

```text
GitHub -> Settings -> Secrets and variables -> Actions
```

| Secret | Gia tri |
| --- | --- |
| `VERCEL_TOKEN` | Access token tao tai Vercel Account Settings -> Tokens |
| `VERCEL_ORG_ID` | `orgId` trong `.vercel/project.json` |
| `VERCEL_PROJECT_ID` | `projectId` trong `.vercel/project.json` |

## Luu y ve Git

Truoc khi deploy, nen xem trang thai thay doi:

```powershell
git status --short --branch
```

Neu chi muon deploy trang thai local hien tai thi khong can commit truoc. Neu muon CI/CD tu deploy qua GitHub, can commit va push len `master`.

Khong xoa hoac revert thay doi trong thu muc `drive/` neu chua chac do la du lieu khong can nua.
