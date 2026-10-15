property supervisorPID : missing value
property projectPath : missing value
property applicationPath : missing value

on run
	set applicationPath to POSIX path of (path to me)
	if applicationPath ends with "/" then set applicationPath to text 1 thru -2 of applicationPath
	set projectPath to do shell script "/usr/bin/dirname " & quoted form of applicationPath
	my startSupervisor()
end run

on reopen
	if supervisorPID is missing value then
		my startSupervisor()
	else
		try
			do shell script "/bin/kill -USR1 " & supervisorPID
		on error
			set supervisorPID to missing value
			my startSupervisor()
		end try
	end if
end reopen

on idle
	if supervisorPID is missing value then return 2
	try
		do shell script "/bin/kill -0 " & supervisorPID
	on error
		set supervisorPID to missing value
		set errorPath to projectPath & "/.local-data/launcher-error.txt"
		set messageText to "启动失败，请重新打开应用。"
		try
			set savedMessage to do shell script "/bin/cat " & quoted form of errorPath
			if savedMessage is not "" then set messageText to savedMessage
		end try
		display dialog messageText with title "DouyinDataReview" buttons {"好"} default button "好" with icon stop
		quit
	end try
	return 2
end idle

on quit
	if supervisorPID is not missing value then
		try
			do shell script "/bin/kill -TERM " & supervisorPID & "; for i in {1..100}; do /bin/kill -0 " & supervisorPID & " 2>/dev/null || exit 0; /bin/sleep 0.1; done; /bin/kill -KILL " & supervisorPID & " 2>/dev/null || true"
		end try
	end if
	set supervisorPID to missing value
	continue quit
end quit

on startSupervisor()
	try
		set nodePath to do shell script "/bin/zsh -lc " & quoted form of "command -v node"
		if nodePath is "" then error "未找到 Node.js。"
		set launcherPath to projectPath & "/scripts/launch-macos.mjs"
		set appPID to do shell script "/bin/echo $PPID"
		set launchCommand to "(cd " & quoted form of projectPath & " && DOUYIN_LAUNCHER_APP_PID=" & quoted form of appPID & " exec " & quoted form of nodePath & " " & quoted form of launcherPath & " 3>&- 4>&- 5>&- 6>&- 7>&- 8>&- 9>&- </dev/null >/dev/null 2>&1) & echo $!"
		set supervisorPID to do shell script launchCommand
	on error errorMessage
		set supervisorPID to missing value
		display dialog errorMessage with title "DouyinDataReview" buttons {"好"} default button "好" with icon stop
	end try
end startSupervisor
