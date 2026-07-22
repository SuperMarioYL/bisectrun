Output demo.gif
Require beta

Set FontSize 15
Set Width 980
Set Height 420
Set Theme Dracula
Set Padding 16
Set TypingSpeed 8

Echo "BisectRun — git-bisect for coding agents"
Sleep 800ms

Type "bisect-run test/fixtures/failed-session.jsonl test/fixtures/good-session.jsonl"
Enter

Sleep 1200ms

Type ""
Sleep 1500ms

Type "# boot the side-by-side diff UI"
Enter
Sleep 400ms

Type "bisect-run test/fixtures/failed-session.jsonl test/fixtures/good-session.jsonl --ui"
Enter

Sleep 2200ms
