# BTN Control

[![ci](https://github.com/qvietdpzai/btn-controll/actions/workflows/ci.yml/badge.svg)](https://github.com/qvietdpzai/btn-controll/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/qvietdpzai/btn-controll?color=7cf29b)](https://github.com/qvietdpzai/btn-controll/releases)
[![license](https://img.shields.io/github/license/qvietdpzai/btn-controll?color=4cc9f0)](LICENSE)

Bảng điều khiển web viết bằng **Rust** (axum): mỗi nút chạy một lệnh trên máy
chủ, trạng thái và log được đẩy về trình duyệt theo thời gian thực qua SSE.

```text
┌──────────────┐   GET /api/buttons     ┌────────────────────┐
│  trình duyệt │ ─────────────────────▶ │  btn-controll      │
│  (HTML/JS)   │ ◀───────────────────── │  Rust · axum       │
└──────────────┘   SSE /api/events      └─────────┬──────────┘
                                                  │ spawn (không shell)
                                                  ▼
                                        buttons.json → program + args
```

- Một binary duy nhất, UI nhúng sẵn bằng `include_str!` — không cần Node, không cần thư mục `dist`.
- Không dùng shell: mỗi nút là `program` + `args`, tránh injection.
- Token bảo vệ mọi thao tác; mặc định chỉ nghe `127.0.0.1`.
- Log realtime (SSE), trạng thái running/exit code, timeout tự kill, stop thủ công.
- Trang demo tĩnh: mở `web/index.html` là chạy được; không có backend thì UI tự chuyển sang mô phỏng.

## Chạy nhanh

```bash
git clone https://github.com/qvietdpzai/btn-controll
cd btn-controll
cargo run
```

Server in ra:

```text
BTN Control v0.1.0
  listening : http://127.0.0.1:8787
  buttons   : 5 (buttons.json)
  token     : 4Kd9... (40 ký tự)
```

Mở <http://127.0.0.1:8787>, bấm icon chìa khoá và dán token. Token được lưu
trong `localStorage` của trình duyệt đó.

Muốn xem UI mà chưa cần backend: mở thẳng `web/index.html` (hoặc deploy thư mục
`web/` lên host tĩnh). Không gọi được `/api/health`, trang tự chuyển sang demo mode.

### Biến môi trường

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `BTN_ADDR` | `127.0.0.1:8787` | Địa chỉ lắng nghe. Dùng `0.0.0.0:8787` nếu muốn truy cập từ máy khác (hãy đọc phần bảo mật). |
| `BTN_TOKEN` | token ngẫu nhiên | Token cố định, in ra console khi khởi động. |
| `BTN_CONFIG` | `./buttons.json` | Đường dẫn file cấu hình nút. |

```bash
BTN_ADDR=0.0.0.0:8787 BTN_TOKEN='doi-token-nay' cargo run
```

## Cấu hình nút

`buttons.json` (mặc định nhúng trong binary nếu không tìm thấy file):

```json
{
  "buttons": [
    {
      "id": "uptime",
      "label": "System status",
      "description": "Xem máy đã chạy bao lâu.",
      "program": "uptime",
      "args": [],
      "confirm": false,
      "timeout_secs": 10,
      "cwd": null
    }
  ]
}
```

| Trường | Bắt buộc | Mô tả |
| --- | --- | --- |
| `id` | ✅ | Định danh duy nhất, dùng trong URL. |
| `label` | ✅ | Tên hiển thị trên nút. |
| `description` | | Mô tả ngắn dưới tên. |
| `program` | ✅ | Chương trình cần chạy (tên trên `PATH` hoặc đường dẫn tuyệt đối). |
| `args` | | Mảng tham số, **không** truyền qua shell. |
| `cwd` | | Thư mục làm việc của tiến trình. |
| `confirm` | | `true` để hỏi xác nhận trước khi chạy. |
| `timeout_secs` | | Tự kill tiến trình sau N giây. |

Ví dụ điều khiển BTN Launcher:

```json
{
  "id": "btn-start",
  "label": "Start BTN",
  "description": "Khởi động BTN Launcher.",
  "program": "/opt/btn/btn-launcher",
  "args": ["--headless"],
  "timeout_secs": 30
}
```

> Nút `btn-launcher` trong file mẫu là placeholder. Sửa `program`/`args` cho
> đúng máy của bạn, hoặc xoá nút đó.

## API

Tất cả endpoint dưới đây (trừ `/api/health`) cần header
`Authorization: Bearer <token>`.

| Method | Đường dẫn | Mô tả |
| --- | --- | --- |
| `GET` | `/api/health` | Trạng thái server, version, uptime. Không cần token. |
| `GET` | `/api/buttons` | Danh sách nút + trạng thái + 300 dòng log gần nhất. |
| `POST` | `/api/buttons/:id/run` | Chạy nút. `409` nếu đang chạy. |
| `POST` | `/api/buttons/:id/stop` | Gửi tín hiệu dừng tiến trình. |
| `GET` | `/api/events?token=...` | SSE: sự kiện `update` với `{"type":"button"}` hoặc `{"type":"log"}`. |

```bash
TOKEN='...'
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/api/buttons
curl -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/api/buttons/disk/run
curl -N "http://127.0.0.1:8787/api/events?token=$TOKEN"
```

## Build trên GitHub (không cần Rust local)

Repo được thiết kế để build hoàn toàn trên hạ tầng GitHub:

- **CI** (`.github/workflows/ci.yml`): `clippy -D warnings`, `cargo test`, build
  release tĩnh (musl) trên Ubuntu, upload binary `btn-controll` làm artifact
  (chạy được trên mọi distro Linux). Lần chạy đầu tự commit `Cargo.lock`.
- **Release** (`.github/workflows/release.yml`): push tag `v*` sẽ build cho
  Linux, Windows và macOS rồi đính kèm file nén vào GitHub Release.
- **Pages** (`.github/workflows/pages.yml`, tuỳ chọn): deploy thư mục `web/` làm
  demo tĩnh. Bật một lần ở **Settings → Pages → Source: GitHub Actions**, sau đó
  chạy workflow `pages` bằng tay (`workflow_dispatch`).

```bash
git tag v0.1.0
git push origin v0.1.0
```

Tải binary từ tab **Actions → artifact** hoặc từ **Releases**.

## Bảo mật

- Mặc định bind `127.0.0.1`: chỉ máy local truy cập được.
- Nếu mở ra Internet, **bắt buộc** đặt `BTN_TOKEN` mạnh và đặt sau reverse proxy
  có HTTPS (Caddy/Nginx/Cloudflare Tunnel). API không có rate limit.
- Token so sánh constant-time; UI lưu token trong `localStorage` (XSS trên cùng
  origin có thể đọc được — đừng nhúng script lạ).
- Lệnh chạy với quyền của user chạy server. Đừng chạy server bằng `root` nếu
  không cần.
- Không có shell: `args` không bị interpolation, nhưng chương trình bạn trỏ tới
  vẫn chạy với đầy đủ quyền — chỉ thêm những nút bạn tin.

## Cấu trúc

```text
btn-controll/
├── src/main.rs              # axum server, API, quản lý tiến trình, SSE
├── web/                     # UI tĩnh, nhúng vào binary khi build
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   └── icon.svg
├── buttons.json             # cấu hình nút
├── .github/workflows/       # ci, release, pages
└── Cargo.toml
```

## Roadmap

- [ ] WebSocket thay SSE (hai chiều, heartbeat rõ hơn)
- [ ] Lưu lịch sử chạy vào SQLite
- [ ] Nút nhóm / pipeline nhiều bước
- [ ] Dockerfile + systemd unit mẫu
- [ ] Đăng nhập nhiều user, phân quyền theo nút

## License

MIT © 2026 [qvietdpzai](https://github.com/qvietdpzai)
