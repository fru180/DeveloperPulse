# DeveloperPulse

DeveloperPulseは、再生中の音を53列×7行のセルでリアルタイムに表現するオーディオビジュアライザーです。音の周波数や強さに応じてセルの明るさが変化します。

DeveloperPulse is an audio visualizer that represents currently playing audio in a real-time 53 × 7 cell display. Cell brightness changes with the frequency and intensity of the sound.

## 日本語

### インストール

Node.js 22.13.0以降が必要です。プロジェクトのディレクトリで次のコマンドを実行します。

```sh
npm install
```

### 起動

#### Web版

```sh
npm run dev
```

起動後、Chromeで`http://localhost:3000`を開きます。

#### macOS版

macOS 13以降、Rust、Xcode Command Line Toolsが必要です。

```sh
npm run tauri dev
```

### 使い方

#### Web版

1. 最新版のChromeでDeveloperPulseを開きます。
2. **Visualize audio**を選択します。
3. 音声を再生しているタブを選び、**Share tab audio**を有効にして共有します。
4. 終了するときは**Stop**を選択します。

#### macOS版

1. DeveloperPulseを起動し、**Visualize audio**を選択します。
2. 初回のみ、macOSの**画面収録とシステムオーディオ録音**へのアクセスを許可します。
3. アクセスを拒否した場合は、アプリ内の**Open System Settings**から設定を開き、DeveloperPulseを有効にします。
4. アプリに戻って**Restart & try again**を選択すると、再起動後に自動で接続を再試行します。
5. 終了するときは**Stop**を選択します。

### 表示の調整

- **Live Cells**: 色で周波数ごとの音の強さを、セル数で音がどれだけ急に立ち上がったかを表示します。
- **Timeline**: 周波数帯ごとの音の強さを時間の流れに沿って表示します。
- **Sensitivity**: 音に対するセルの反応の強さを調整します。
- 画面右上のボタンでライト表示とダーク表示を切り替えられます。

## English

### Installation

Node.js 22.13.0 or later is required. Run the following command in the project directory:

```sh
npm install
```

### Launch

#### Web

```sh
npm run dev
```

After the server starts, open `http://localhost:3000` in Chrome.

#### macOS

macOS 13 or later, Rust, and Xcode Command Line Tools are required.

```sh
npm run tauri dev
```

### How to use

#### Web

1. Open DeveloperPulse in the latest version of Chrome.
2. Select **Visualize audio**.
3. Choose the tab playing audio, enable **Share tab audio**, and share it.
4. Select **Stop** when you are finished.

#### macOS

1. Open DeveloperPulse and select **Visualize audio**.
2. On first use, allow access to **Screen & System Audio Recording** in macOS.
3. If access was denied, select **Open System Settings** in the app and enable DeveloperPulse.
4. Return to the app and select **Restart & try again** to restart and reconnect automatically.
5. Select **Stop** when you are finished.

### Display controls

- **Live Cells**: Uses color for audio intensity and cell count for how suddenly audio rises across frequencies.
- **Timeline**: Shows audio intensity by frequency band over time.
- **Sensitivity**: Adjusts how strongly the cells react to audio.
- Use the button in the upper-right corner to switch between light and dark modes.
