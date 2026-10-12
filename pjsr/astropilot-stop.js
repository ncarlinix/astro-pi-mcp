// AstroPilot Stop — one-click stop for the AstroPilot watcher (companion to astropilot-watcher.js).
// Writes the watcher's shutdown sentinel; the running watcher consumes it within ~0.5s and exits
// cleanly. Use this instead of the Process Console abort button — it never depends on
// console.abortEnabled (which a just-run process can leave disabled).
//
// One-time setup: SCRIPT > Feature Scripts… > Add, point it at this pjsr/ directory, and both
// "AstroPilot > Start Watcher" and "AstroPilot > Stop Watcher" appear in the SCRIPT menu. You can
// then assign each a keyboard shortcut in EDIT > Global Preferences > Keyboard if you like.

#feature-id    AstroPilotStop : AstroPilot > Stop Watcher
#feature-info  Stops a running AstroPilot watcher by writing its shutdown sentinel to \
   ~/.astropilot/bridge/shutdown. The watcher removes the file and exits within ~0.5s. \
   Safe to run even if no watcher is active.

var BRIDGE_DIR = File.homeDirectory + "/.astropilot/bridge";

(function stop() {
   if ( !File.directoryExists( BRIDGE_DIR ) ) {
      console.warningln( "[AstroPilot] No bridge directory at " + BRIDGE_DIR + " — nothing to stop." );
      return;
   }
   var sentinel = BRIDGE_DIR + "/shutdown";
   try {
      var f = new File;
      f.createForWriting( sentinel );
      f.outTextLn( "stop" );
      f.close();
      console.noteln( "[AstroPilot] Shutdown requested — a running watcher will stop within ~0.5s." );
   } catch ( e ) {
      console.criticalln( "[AstroPilot] Could not write shutdown sentinel: " + ( e.message || e ) );
   }
})();
