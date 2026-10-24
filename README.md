<div align="center">

# 🎨 BossFreeForm

**Infinite Canvas Whiteboard & Visual Workspace for Windows & Web (Synced with Google Drive)**  
**감성을 담은 Windows & 웹 겸용 무한 캔버스 화이트보드 · 시각적 워크스페이스**

[![Donate with PayPal](https://img.shields.io/badge/Donate-PayPal-00457C?style=for-the-badge&logo=paypal&logoColor=white)](https://www.paypal.com/cgi-bin/webscr?cmd=_donations&business=cirross2%40gmail.com&item_name=BossFreeForm+Open+Source+Support&currency_code=USD)
[![Web Demo](https://img.shields.io/badge/Web_App-boss--freeform--web.vercel.app-0071e3?style=for-the-badge&logo=vercel&logoColor=white)](https://boss-freeform-web.vercel.app)
[![License: MIT](https://img.shields.io/badge/License-MIT-30d158?style=for-the-badge)](./LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows_%7C_Web-1d1d1f?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/cirross2/BossFreeForm-)

<br />

**[🇰🇷 한국어 가이드 (Korean)](#-한국어-가이드-korean)** &nbsp;|&nbsp; **[🇺🇸 English Guide](#-english-guide)** &nbsp;|&nbsp; **[☕ 후원하기 / Support & Donate](#-후원하기--support--donate)**

</div>

---

## 🇰🇷 한국어 가이드 (Korean)

**BossFreeForm**은 Apple의 **Freeform(프리폼)** 디자인 철학을 Windows 데스크톱과 웹 브라우저 환경으로 확장한 **오픈소스 무한 캔버스(Infinite Canvas) 화이트보드 및 지식 관리 앱**입니다.  
노트, 체크리스트, 엑셀 호환 표, 벡터 스티커, 스마트 펜/도형, 내장 PDF 문서 뷰어를 하나의 끝없는 캔버스 위에 자유롭게 배치하고 **Google Drive**를 통해 PC와 웹(`https://boss-freeform-web.vercel.app`) 어디서든 이어서 작업할 수 있습니다.

### ✨ 주요 기능 (Key Features)

#### 1. ♾️ 무한 캔버스 & 직관적인 양손/마우스 패닝 조작
- **어디서든 즉시 캔버스 이동 (3가지 방식 지원)**:
  1. **마우스 휠 클릭(스크롤 버튼) + 드래그**
  2. **마우스 좌·우 버튼 동시 클릭 + 드래그** *(객체 위나 펜/도형 모드에서도 즉시 캔버스 이동!)*
  3. **빈 캔버스 좌클릭 + 드래그**
- **커서 중심 부드러운 확대/축소**: 마우스 휠 스크롤로 `20%` ~ `350%` 줌 인/아웃, 하단 HUD에서 `100%` 초기화 및 전체 객체 화면 맞춤(`Fit View`) 지원.
- **배경 격자 및 스냅 설정**: 도트(`Dots`), 격자(`Lines`), 무지(`None`) 스타일 전환, 간격(`mm`/`px`) 조절, 객체 및 펜 드로잉 격자 스냅, 다크/라이트 테마 완벽 지원.

#### 2. 🖐️ 왼손 원키(Single-Key) 빠른 도구 단축키
텍스트 입력 중이 아닐 때 키보드 왼쪽 키 하나만으로 모든 핵심 도구와 객체를 즉시 생성·전환할 수 있습니다.

| 단축키 | 도구 / 객체 | 설명 |
| :---: | :--- | :--- |
| **`Ctrl + Shift + Space`** | **글로벌 보드 호출 / 숨기기** | PC 작업 중 언제든 보스프리폼 창을 즉시 호출하거나 숨김 (사용자 커스텀 가능) |
| **`A`** (보조 `V`) | **선택 도구** | 객체 선택, 이동, `Shift + 드래그` 다중 선택 박스(Marquee) |
| **`D`** (보조 `P`) | **스마트 펜** | 자유 곡선, 직선(`Ctrl`/`Shift`), 화살표 및 도형 자동 보정 드로잉 |
| **`B`** | **도형 그리기** | 사각형, 원형, 삼각형, 마름모, 화살표 등 벡터 도형 및 배경 잠금 |
| **`S`** | **포스트잇 (노트)** | 생성 시 다채로운 랜덤 컬러로 생성되는 자유 메모 카드 |
| **`T`** / **`F`** | **텍스트 (타이틀)** | 보더리스 투명 타이틀, 8종 그래픽 텍스트 아트 & 고해상도 벡터화 |
| **`C`** | **체크리스트** | 랜덤 컬러 할 일 카드 + **완료 항목만 복사 / 미완료 항목만 복사** 원클릭 버튼 |
| **`G`** (보조 `R`) | **표 (시트)** | 엑셀·구글 시트 복사/붙여넣기 호환, 다중 셀 드래그 선택 및 CSV 내보내기 |
| **`X`** | **화면 캡처** | 현재 PC 화면을 즉시 캡처하여 캔버스 이미지 객체로 삽입 |
| **`Ctrl + F`** | **통합 검색** | 노트, 타이틀, 객체 이름, 그룹 이름, **PDF 본문 텍스트**까지 실시간 하이라이트 검색 |
| **`Ctrl + G`** | **그룹화 / 그룹명** | 다중 선택된 객체들을 하나의 그룹 프레임으로 묶고 **그룹 이름** 지정 |

#### 3. 🌟 벡터 스티커 객체 (30종 기본 제공 + PNG 자동 벡터화)
- **기본 벡터 스티커 30종 내장**: 하트, 별, 해, 달, 연필, 전구, 모니터, 노트북, 체크, 화살표, 왕관, 로켓 등 자주 쓰는 30종의 고품질 SVG 스티커 기본 탑재.
- **투명 PNG 추가 시 자동 벡터화**: 사용자가 투명 배경 PNG 파일을 스티커로 등록하면 자동으로 SVG 벡터 패스로 변환되어, 아무리 크게 확대해도 픽셀 깨짐 없이 선명하게 유지됩니다.
- **자유 회전 & 비율 고정/왜곡 리사이즈**: 선택 시 내부에 자동 숨김 컨트롤 바가 나타나며, 상단 회전 핸들로 360° 회전하거나 비율 고정을 해제해 자유롭게 늘이고 줄일 수 있습니다.

#### 4. 📄 내장 PDF 문서 뷰어 객체
- **한 페이지 비율 자동 맞춤**: 가로형(Landscape)·세로형(Portrait) PDF 문서의 실제 페이지 비율을 자동 감지하여 여백 없이 깔끔하게 렌더링하며, 크기 조절 시에도 페이지 비율이 엄격하게 유지됩니다.
- **자동 숨김 컨트롤 & 외곽선**: 마우스를 올렸을 때만 페이지 이동·확대/축소·모드 전환 바가 부드럽게 나타나며, 이미지 객체와 동일하게 외곽선(테두리) 두께 및 색상을 지정할 수 있습니다.
- **PDF 본문 통합 검색**: PDF 내부의 모든 페이지 텍스트를 자동 인덱싱하여 `Ctrl + F` 검색 시 PDF 안의 단어까지 즉시 찾아줍니다.

#### 5. ☁️ Google Drive & 웹 버전 클라우드 동기화
- **단일 경로 통합 관리**: `G:\내 드라이브\BossFreeForm` (보드 `.json` 및 `assets/` 첨부 파일) 단일 경로로 깔끔하게 통합 관리합니다.
- **웹 버전 연동 (`https://boss-freeform-web.vercel.app`)**:
  - 이벤트 기반(보드 저장 시, 창/탭 포커스 시, 수동 동기화 시) 클라우드 동기화 아키텍처로 서버 부하 없이 PC 상태와 무관하게 모든 보드와 첨부 파일(이미지, PDF, 스티커)을 동기화합니다.

### 🚀 설치 및 실행 방법 (Getting Started)

```bash
# 1. 저장소 클론 및 패키지 설치
git clone https://github.com/cirross2/BossFreeForm-.git
cd BossFreeForm-
npm install

# 2. 개발 모드 실행
npm start

# 3. 무설치 단독 실행 파일(Portable .exe) 빌드 -> dist/BossFreeForm/BossFreeForm.exe
npm run build:exe

# 4. (선택) Windows 설치 인스톨러(Setup.exe) 빌드
npm run build:setup
```

---

## 🇺🇸 English Guide

**BossFreeForm** is an open-source **Infinite Canvas Whiteboard & Visual Workspace** for Windows Desktop and the Web, inspired by Apple's **Freeform** design philosophy.  
Combine sticky notes, checklists, Excel-compatible tables, vector stickers, smart pen strokes, and interactive PDF viewers on a boundless canvas—seamlessly synced via **Google Drive** across Desktop and Web (`https://boss-freeform-web.vercel.app`).

### ✨ Key Features

#### 1. ♾️ Infinite Canvas & Effortless Mouse Panning
- **3 Ways to Pan Anywhere on the Canvas**:
  1. **Middle-Mouse (Scroll Wheel) Click + Drag**
  2. **Left + Right Mouse Buttons Simultaneous Click + Drag** *(Works anywhere—even directly over objects or while in Pen/Shape mode!)*
  3. **Left-Click + Drag on Empty Canvas**
- **Smooth Cursor-Centered Zoom**: Scroll wheel zooms smoothly between `20%` and `350%`, with one-click `100%` reset and `Fit to Content` in the bottom-right HUD.
- **Customizable Grid & Snapping**: Switch between `Dots`, `Lines`, and `None`, customize spacing in `mm` or `px`, toggle object/drawing grid snap, and switch between **Dark & Light Themes**.

#### 2. 🖐️ Single-Key Left-Hand Tool Shortcuts
Switch tools or spawn new objects instantly with a single left-hand keystroke when not typing text:

| Shortcut | Tool / Object | Description |
| :---: | :--- | :--- |
| **`Ctrl + Shift + Space`** | **Global Summon / Hide** | Instantly summon or hide the BossFreeForm window from anywhere on Windows (customizable) |
| **`A`** (`V`) | **Select Tool** | Select, move, or `Shift + Drag` marquee multi-select objects |
| **`D`** (`P`) | **Smart Pen** | Freehand ink, straight lines (`Ctrl`/`Shift`), arrows, and auto-shape recognition |
| **`B`** | **Shape Tool** | Draw rectangles, circles, triangles, diamonds, arrows, or lock shapes as background |
| **`S`** | **Sticky Note** | Spawn a sticky note card with a vibrant randomized color palette |
| **`T`** / **`F`** | **Borderless Text** | Transparent title object with 8 graphic text art styles & crisp SVG vectorization |
| **`C`** | **Checklist** | Randomized color task card with one-click **Copy Checked Only** & **Copy Unchecked Only** buttons |
| **`G`** (`R`) | **Table (Sheet)** | Interactive table with Excel/Google Sheets copy-paste, multi-cell selection & CSV export |
| **`X`** | **Screen Capture** | Instantly capture your screen and drop it onto the canvas as an image object |
| **`Ctrl + F`** | **Unified Search** | Live search across notes, vectorized titles, object names, group names & **full PDF text** |
| **`Ctrl + G`** | **Group & Naming** | Group selected objects together with a customizable **Group Title Badge** |

#### 3. 🌟 Vector Sticker Objects (30 Built-in Stickers + Auto PNG Vectorization)
- **30 Built-in Vector Stickers**: Includes versatile everyday icons (heart, star, sun, moon, pencil, lightbulb, monitor, laptop, crown, rocket, checkmarks, arrows, and more).
- **Automatic PNG-to-SVG Vectorization**: Register any transparent PNG as a custom sticker—BossFreeForm automatically vectorizes it so it stays razor-sharp at any zoom level or scale.
- **Rotation & Free Aspect Stretch**: Features an auto-hiding interior header bar with a 360° rotation handle and toggleable aspect-ratio lock for free non-proportional stretching.

#### 4. 📄 Built-in Interactive PDF Viewer Object
- **Single-Page Aspect-Ratio Lock**: Automatically detects portrait or landscape PDF page dimensions, fitting the viewer cleanly to a single page and locking resize proportions to the page's exact aspect ratio.
- **Auto-Hiding Chrome & Custom Borders**: Top title and page navigation controls auto-hide until hovered, and you can style PDF cards with customizable border outlines just like image objects.
- **Full-Text PDF Search**: Automatically indexes text across all PDF pages so `Ctrl + F` highlights and counts matches inside your PDF documents.

#### 5. ☁️ Google Drive & Web Cloud Synchronization
- **Unified Storage**: Stores boards (`.json`) and attachments (`assets/`) cleanly in a single `Google Drive/BossFreeForm` directory.
- **Event-Driven Web Sync (`https://boss-freeform-web.vercel.app`)**: Syncs boards and uploaded assets across PC and Web on save, window/tab focus, or manual sync—delivering instant cross-device access with near-zero idle server load.

### 🚀 Build & Run Instructions

```bash
# 1. Clone the repository & install dependencies
git clone https://github.com/cirross2/BossFreeForm-.git
cd BossFreeForm-
npm install

# 2. Run in development mode
npm start

# 3. Build standalone portable executable (dist/BossFreeForm/BossFreeForm.exe)
npm run build:exe

# 4. (Optional) Build Windows installer (Setup.exe)
npm run build:setup
```

---

## ☕ 후원하기 / Support & Donate

<div align="center">

**BossFreeForm**이 업무와 창작에 도움이 되셨다면, 페이팔(PayPal)을 통해 개발자에게 따뜻한 커피 한 잔을 후원해 주세요!  
여러분의 후원은 새로운 기능 개발과 오픈소스 유지보수에 큰 힘이 됩니다. 💖

If **BossFreeForm** helps your workflow and creativity, please consider supporting the project via **PayPal**!  
Your support directly fuels new features, cloud improvements, and open-source maintenance. 💖

<br />

[![Donate with PayPal](https://img.shields.io/badge/☕_Support_via_PayPal-cirross2%40gmail.com-0070ba?style=for-the-badge&logo=paypal&logoColor=white)](https://www.paypal.com/cgi-bin/webscr?cmd=_donations&business=cirross2%40gmail.com&item_name=BossFreeForm+Open+Source+Support&currency_code=USD)

**PayPal Account / Direct Donation Link**:  
👉 **[https://www.paypal.com/cgi-bin/webscr?cmd=_donations&business=cirross2@gmail.com&currency_code=USD](https://www.paypal.com/cgi-bin/webscr?cmd=_donations&business=cirross2%40gmail.com&item_name=BossFreeForm+Open+Source+Support&currency_code=USD)**  
*(PayPal Email: `cirross2@gmail.com`)*

</div>

---

## 📜 License

Released under the [MIT License](./LICENSE). Copyright © 2026 **Doyoon Baek (`cirross2`)**.
