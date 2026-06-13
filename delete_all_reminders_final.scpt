tell app "Reminders"
	try
		-- Get all reminders from all lists
		set allReminders to every reminder
		
		-- Delete those reminders
		repeat with aReminder in allReminders
			delete aReminder
		end repeat
		
		-- Also try deleting from other visible lists if any, based on what we see
	on error errMsg
		return "Error: " & errMsg
	end try
end tell