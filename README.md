<img width="640" height="537" alt="image" src="https://github.com/user-attachments/assets/3a89348b-e4a0-4aa5-93f5-38bfeb8dce5c" />


**I made a Public Voice Finder for Suno: Find voices while browsing or search by genre**

Sharing a userscript that adds a **Voice Finder** button beneath Home in Suno’s sidebar.

With the panel open, it gathers public voices as you browse, search, and scroll through Suno. You can also **search for voices by genre** directly from the panel.

Features:

* **Genre search** with Most Relevant, Trending, Most Played, Oldest, and Most Recent sorting.
* **Open Voice** and **Copy URL** buttons for each result.
* Duplicate filtering so the same voice doesn’t keep appearing.
* Up to **500 collected voices**.
* A download icon beside Clear to **export your collected voices as CSV**.
* Optional **Auto Scroll** every **7 seconds**. It starts OFF and turns OFF again when you close the panel.

**How to install**

You’ll need the [Tampermonkey browser extension](https://www.tampermonkey.net/) to run it.

1. Install Tampermonkey.
2. [Open the script here](https://raw.githubusercontent.com/dtankdempsey2/suno-voice-finder/refs/heads/main/Suno-Public-Voice-Finder.user.js) and copy all the code.
3. Create a new script in Tampermonkey, replace the starter code with the copied code, and save.
4. Reload Suno while signed in, then open **Voice Finder** under Home.

If you haven’t installed a userscript before, look up a quick video on **“how to install a Tampermonkey script”** or ask an AI to walk you through it for your browser.

I chose a Tampermonkey script because I already use several scripts in my Suno workflow. Keeping them together works better for me than installing a separate browser extension for each one. if someone else wants to make it a browser plugin and share, feel free to do so.

This is an unofficial community tool for discovering public voices on Suno and is not affiliated with Suno. I’m sharing it as is, with no guarantees. Use it responsibly and at your own risk, I’m not responsible for how others use or misuse it.

**Don't trust me:** Run the script through AI and ask if it's malicious.

The script helps you discover publicly available voices on Suno. Open a voice’s page and use Suno’s own **Create with Voice** button to create a song with it. The script makes those voices easier to find, it doesn’t unlock private voices or bypass access restrictions.

**Important:** After installing the script, reload the Suno page and look for **Voice Finder** underneath the **Home** button in the sidebar.
