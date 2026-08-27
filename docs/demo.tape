Output docs/demo.gif
Set Theme "Dracula"
Set Width 1200
Set Height 680
Set FontSize 20
Set Padding 24
Set TypingSpeed 30ms
Set Framerate 40
Set Shell "bash"

Type "alias unswallow='node packages/unswallow/dist/cli/index.js'"
Enter
Sleep 400ms

Type "unswallow check"
Enter
Sleep 4s

Type "unswallow check --fixture packages/bench/fixtures/vllm-qwen3-0.19-tool-choice-required-pattern-b.json"
Enter
Sleep 4s

Type "unswallow matrix"
Enter
Sleep 3s

Type "cd packages/python && python3 -m unswallow.cli check"
Enter
Sleep 3s

Type "cd ../.. && printf 'npm i unswallow   |   pip install unswallow   |   0 dependencies\n'"
Enter
Sleep 2s

Type "exit"
Enter
Sleep 1s