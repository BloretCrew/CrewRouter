'use strict';

// Generated from @bloret-crew/blora-design-theming 2.0.8 getThemeBootScript().
// Keep this synchronous so server-rendered pages can place it before Blora CSS.
const themeBootScript = '(function(){var r=document.documentElement,t=["coral","indigo","graphite","mono","circuit","dusk"],s="coral",c="light";try{var saved=localStorage.getItem("blora-theme");if(saved&&t.indexOf(saved)!==-1)s=saved;var storedScheme=localStorage.getItem("blora-color-scheme");if(storedScheme==="dark"||storedScheme==="light")c=storedScheme;}catch(e){}r.setAttribute("data-blora-theme",s);r.setAttribute("data-blora-color-scheme",c);r.style.colorScheme=c;}());';

module.exports = { themeBootScript };
