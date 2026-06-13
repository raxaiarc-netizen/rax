tell app "Reminders"
    set myDate to (current date)
	set day of myDate to 1 -- Set to the 1st of the current month
	set month of myDate to June
	set year of myDate to 2026
	set time of myDate to 0
	
	set startOfMonth to myDate
	
	-- Calculate start of next month
	set monthNum to (month of startOfMonth as integer)
	set nextMonthNum to (monthNum mod 12) + 1
	set nextMonthYear to (year of startOfMonth)
	if nextMonthNum is 1 then
		set nextMonthYear to nextMonthYear + 1
	end if
	
	set day of myDate to 1
	set month of myDate to nextMonthNum
	set year of myDate to nextMonthYear
	set time of myDate to 0
	set startOfNextMonth to myDate

    -- Get all reminders from default list
    set allReminders to reminders of default list
    
    repeat with aReminder in allReminders
        if due date of aReminder is not missing value then
            set remDueDate to due date of aReminder
            if remDueDate ≥ startOfMonth and remDueDate < startOfNextMonth then
                delete aReminder
            end if
        end if
    end repeat
end tell