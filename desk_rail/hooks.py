app_name = "desk_rail"
app_title = "Desk Rail"
app_publisher = "G2Virtu.com"
app_description = (
	"A persistent workspace navigation rail and instant-redirect navigation v14-v15"
	"for the Frappe/ERPNext desk."
)
app_email = "info@g2virtu.com"
app_license = "MIT"

# ------------------------------------------------------------------------------
# Assets injected into the desk
# ------------------------------------------------------------------------------
app_include_js = ["/assets/desk_rail/js/desk_rail.js"]
app_include_css = ["/assets/desk_rail/css/desk_rail.css"]

# ------------------------------------------------------------------------------
# Boot — ship the rail config + redirect map to the client
# ------------------------------------------------------------------------------
extend_bootinfo = "desk_rail.boot.boot_session"

# ------------------------------------------------------------------------------
# Fixtures — the two Workspace custom fields that drive instant-redirect
# ------------------------------------------------------------------------------
fixtures = [
	{
		"doctype": "Custom Field",
		"filters": [["name", "in", ["Workspace-instant_redirect", "Workspace-redirect_url"]]],
	},
]
