; electron-builder 自动带上这个文件。选完安装目录后多一页「可选功能」：视频解析，默认不装。
; 勾选结果写到安装目录的 resources 里，应用第一次启动时读走删掉，之后以设置面板里的为准。
; 自动更新（--updated）不显示这一页也不写文件，用户在设置里的选择保持不变。

!macro customPageAfterChangeDir
  !include nsDialogs.nsh
  Var analysisCheckbox
  Var analysisChoice
  Page custom analysisPageShow analysisPageLeave

  Function analysisPageShow
    !insertmacro MUI_HEADER_TEXT "可选功能" "现在不装的话，以后也可以在设置里安装。"
    nsDialogs::Create 1018
    Pop $0
    ${NSD_CreateCheckbox} 0 0 100% 12u "视频解析"
    Pop $analysisCheckbox
    ${if} $analysisChoice == ${BST_CHECKED}
      ${NSD_Check} $analysisCheckbox
    ${endif}
    ${NSD_CreateLabel} 12u 16u -12u 40u "用 AI 拆解视频的选题、结构和拍法，结果存在侧栏的「解析库」里。需要自备火山方舟的 API Key。"
    Pop $0
    nsDialogs::Show
  FunctionEnd

  Function analysisPageLeave
    ${NSD_GetState} $analysisCheckbox $analysisChoice
  FunctionEnd
!macroend

!macro customInstall
  ${ifNot} ${isUpdated}
    FileOpen $0 "$INSTDIR\resources\install-options.json" w
    ${if} $analysisChoice == ${BST_CHECKED}
      FileWrite $0 '{"analysis":true}'
    ${else}
      FileWrite $0 '{"analysis":false}'
    ${endif}
    FileClose $0
  ${endif}
!macroend
