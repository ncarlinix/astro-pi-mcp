// AstroPilot Watcher — runs inside PixInsight's PJSR engine (V8 runtime, PixInsight 1.9.4+)
// Polls the bridge directory for commands from the AstroPilot MCP server, executes them,
// and writes JSON results. This is a pure PJSR script: NO native module and NO signing
// required. Open it in the Script Editor and run (F9), or add via SCRIPT > Feature Scripts.
//
// Adapted from the reference pixinsight-mcp watcher (MIT). The native-module route was
// dropped (it requires a signed module, unavailable here); this foreground loop calls
// CoreApplication.processEvents() frequently so the UI stays usable while polling.

#engine v8

#feature-id    AstroPilotWatcher : AstroPilot > Start Watcher
#feature-info  Starts the AstroPilot bridge watcher. Polls ~/.astropilot/bridge for \
   commands issued by an AI assistant (via the AstroPilot MCP server) and executes them \
   inside PixInsight. Leave running during an AstroPilot session.

CoreApplication.ensureMinimumVersion( 1, 9, 4 );

// ============================================================================
// Configuration
// ============================================================================

var BRIDGE_DIR = File.homeDirectory + "/.astropilot/bridge";
var COMMANDS_DIR = BRIDGE_DIR + "/commands";
var RESULTS_DIR = BRIDGE_DIR + "/results";
var LOGS_DIR = BRIDGE_DIR + "/logs";
// Effective idle poll cadence: the main loop sleeps 25 x 20 ms between checks. Informational.
var POLL_INTERVAL_MS = 500;
var WATCHER_VERSION = "0.0.1";

// Bump on ANY behavioral handler change. Every success result echoes it as
// outputs.watcherRev so the MCP server can detect a stale watcher (EXPECTED_WATCHER_REV
// in src/types.ts must match).
// rev 2: added session/history handlers (get_history, get_full_history, undo, redo,
//        snapshot, restore, export_container).
// rev 3: run_process / run_process_icon now report outputs.executed (false when a process
//        silently DECLINES, e.g. SPCC without a catalog or MGC without MARS coverage).
// rev 4: error messages normalized via errMessage() (PJSR throws raw strings whose .message
//        is undefined, which was surfacing as "Error executing run_process: undefined");
//        instantiateProcess now rejects known SCRIPT-menu tools (ImageSolver, etc.) with an
//        actionable hint instead of a cryptic "not defined".
// rev 5: shutdown latch — the shutdown file / Ctrl+F11 now reliably stops the watcher. The
//        previous inner-loop break only exited the sleep loop while shouldShutdown() had
//        already consumed the file, so the watcher polled on forever and locked the UI.
// rev 6: run_process no longer generates undo/swap history by default (executeOn(view,false)) —
//        the previous default retained a full-res undo snapshot per step, leaking GBs of RAM on
//        automated pipelines. Pass keepHistory:true to opt back into undo/redo for a step.
var WATCHER_REVISION = 6;

// Commands older than this are refused (dead-session leftovers). Matches the client's
// stale threshold so a queued save/close never fires late with surprising side effects.
var STALE_COMMAND_MS = 10 * 60 * 1000;

// ============================================================================
// File Helpers (PJSR File API)
// ============================================================================

function readTextFile( path ) {
   return File.readLines( path ).join( "\n" );
}

function deleteFile( path ) {
   if ( File.exists( path ) )
      File.remove( path );
}

function ensureDirectory( path ) {
   if ( !File.directoryExists( path ) )
      File.createDirectory( path, true );
}

function listJsonFiles( dirPattern ) {
   try {
      return File.searchDirectory( dirPattern );
   } catch ( e ) {
      return [];
   }
}

function getTimestamp() {
   return (new Date()).toISOString();
}

// PJSR frequently throws raw strings for native core errors (e.g. a process failing in
// executeOn), and a String has no `.message` — reading it yields undefined, which is how a
// real failure was surfacing as "Error executing run_process: undefined". Normalize so the
// actual text always survives into logs and result JSON.
function errMessage( e ) {
   if ( e == null ) return "unknown error";
   if ( typeof e === "string" ) return e;
   if ( e.message ) return e.message;
   return String( e );
}

// ============================================================================
// Utility Functions
// ============================================================================

function findWindowByViewId( viewId ) {
   var windows = ImageWindow.windows;
   for ( var i = 0; i < windows.length; ++i ) {
      if ( windows[i].mainView.id === viewId )
         return windows[i];
      for ( var j = 0; j < windows[i].previews.length; ++j )
         if ( windows[i].previews[j].id === viewId )
            return windows[i];
   }
   return null;
}

function findViewById( viewId ) {
   var windows = ImageWindow.windows;
   for ( var i = 0; i < windows.length; ++i ) {
      if ( windows[i].mainView.id === viewId )
         return windows[i].mainView;
      for ( var j = 0; j < windows[i].previews.length; ++j )
         if ( windows[i].previews[j].id === viewId )
            return windows[i].previews[j];
   }
   return null;
}

// Resolve a target window: by view id when given, else the active window. Throws clearly.
function resolveWindow( viewId ) {
   if ( viewId ) {
      var w = findWindowByViewId( viewId );
      if ( !w ) throw new Error( "Image not found: " + viewId );
      return w;
   }
   var aw = ImageWindow.activeWindow;
   if ( aw.isNull ) throw new Error( "No view specified and no active image." );
   return aw;
}

// SCRIPT-menu tools shipped as PJSR scripts (loaded with #include) are NOT Process classes,
// so `new <name>` throws "not defined" inside eval. Map the ones assistants reach for most to
// an actionable hint instead of a cryptic failure.
var KNOWN_SCRIPTS = {
   ImageSolver:          "plate solving is done by the 'plate_solve' tool (ASTAP), not run_process/get_process_parameters",
   SubframeSelector:     "run it from the SCRIPT menu; it is not a scriptable Process",
   MosaicByCoordinates:  "PJSR script, not a Process",
   AnnotateImage:        "PJSR script, not a Process"
};

function instantiateProcess( processId ) {
   if ( !/^[A-Za-z_][A-Za-z0-9_]*$/.test( processId || "" ) )
      throw new Error( "Invalid process id: " + processId );
   if ( KNOWN_SCRIPTS.hasOwnProperty( processId ) )
      throw new Error( processId + " is a PixInsight script, not a process — " + KNOWN_SCRIPTS[processId] );
   var P;
   try {
      P = eval( "new " + processId + ";" );
   } catch ( e ) {
      throw new Error( "Unknown process: " + processId + " (" + errMessage( e ) + ")" );
   }
   return P;
}

// ============================================================================
// Command Handlers
// ============================================================================

function handleListOpenImages() {
   var windows = ImageWindow.windows;
   var images = [];
   for ( var i = 0; i < windows.length; ++i ) {
      var v = windows[i].mainView, img = v.image;
      images.push({
         id: v.id,
         filePath: windows[i].filePath || null,
         width: img.width,
         height: img.height,
         channels: img.numberOfChannels,
         isColor: img.isColor,
         bitDepth: img.bitsPerSample
      });
   }
   return { status: "success", outputs: { images: images },
            message: "Found " + images.length + " open image(s)" };
}

function handleActiveImage() {
   var w = ImageWindow.activeWindow;
   if ( w.isNull )
      return { status: "success", outputs: { active: null }, message: "No active image" };
   var v = w.mainView, img = v.image;
   return {
      status: "success",
      outputs: {
         id: v.id, filePath: w.filePath || null,
         width: img.width, height: img.height,
         channels: img.numberOfChannels, isColor: img.isColor, bitDepth: img.bitsPerSample
      },
      message: "Active image: " + v.id
   };
}

function handleOpenImage( command ) {
   var filePath = command.parameters.filePath;
   if ( !File.exists( filePath ) )
      throw new Error( "File not found: " + filePath );
   var windows = ImageWindow.open( filePath );
   if ( windows.length === 0 )
      throw new Error( "Failed to open image: " + filePath );
   var w = windows[0];
   w.show();
   var v = w.mainView, img = v.image;
   return { status: "success",
            outputs: { id: v.id, width: img.width, height: img.height, channels: img.numberOfChannels },
            message: "Opened " + v.id };
}

function handleSaveImage( command ) {
   var viewId = command.parameters.viewId;
   var filePath = command.parameters.filePath;
   var overwrite = command.parameters.overwrite || false;
   // Default compressed. Explicit codec keeps written file sizes reproducible (XISF format
   // defaults are session-mutable; see the reference watcher's notes).
   var compression = command.parameters.compression || "zlib+sh";
   var validCodecs = ["zlib", "zlib+sh", "zstd", "zstd+sh", "lz4", "lz4+sh", "lz4hc", "lz4hc+sh", "none"];
   if ( validCodecs.indexOf( compression ) < 0 )
      throw new Error( "Unknown compression codec: " + compression + " (valid: " + validCodecs.join( ", " ) + ")" );

   var window = resolveWindow( viewId );
   if ( File.exists( filePath ) && !overwrite )
      throw new Error( "File already exists (set overwrite=true): " + filePath );

   var isXisf = /\.xisf$/i.test( filePath );
   var hints = isXisf ? ("compression-codec " + compression) : "";
   window.saveAs( filePath, false, false, false, false, hints );

   var bytes = -1;
   try { bytes = new FileInfo( filePath ).size; } catch ( e ) {}

   return { status: "success",
            outputs: { filePath: filePath, hints: hints, bytes: bytes },
            message: "Saved " + window.mainView.id + " to " + filePath };
}

function handleCloseImage( command ) {
   var window = resolveWindow( command.parameters.viewId );
   var closedId = window.mainView.id;
   window.forceClose();
   return { status: "success", outputs: {}, message: "Closed " + closedId };
}

function handleGetImageStatistics( command ) {
   var window = resolveWindow( command.parameters.viewId );
   var viewId = window.mainView.id;
   var img = window.mainView.image;
   var stats = [];
   var channelNames = img.isColor ? ["Red", "Green", "Blue"] : ["Gray"];
   for ( var c = 0; c < img.numberOfChannels; ++c ) {
      img.selectedChannel = c;
      stats.push({
         channel: c,
         channelName: c < channelNames.length ? channelNames[c] : "Channel_" + c,
         mean: img.mean(), median: img.median(), stdDev: img.stdDev(),
         min: img.minimum(), max: img.maximum()
      });
   }
   img.resetSelections();
   return { status: "success", outputs: { statistics: stats },
            message: "Statistics for " + viewId + " (" + stats.length + " channel(s))" };
}

// Generic process runner — run ANY PixInsight process by class name.
function handleRunProcess( command ) {
   var p = command.parameters || {};
   var processId = p.processId || command.process;
   var P = instantiateProcess( processId );

   // Reject unknown settings (a typo would otherwise create a plain JS property, run with
   // defaults, and still report the setting as applied).
   var known = {};
   for ( var q in P ) if ( typeof P[q] !== "function" ) known[q] = true;
   var settings = p.settings || {};
   var applied = [];
   for ( var k in settings ) {
      if ( settings.hasOwnProperty( k ) ) {
         if ( !known.hasOwnProperty( k ) )
            throw new Error( "Unknown parameter '" + k + "' for " + processId +
                             ", check get_process_parameters(\"" + processId + "\")" );
         P[k] = settings[k];
         applied.push( k );
      }
   }

   // Undo/swap history: executeOn(view, swapFile) keeps a FULL-RES undo snapshot when swapFile is
   // true (the default). For automated pipelines that is a massive memory leak — a dozen steps on a
   // 5496x3672 master retains GBs of undo images. Default to NO history (swapFile=false); callers
   // that actually want undo/redo can pass keepHistory:true.
   var keepHistory = (p.keepHistory === true) || (command.keepHistory === true);

   // Capture the execute return: PixInsight processes return `false` when they DECLINE
   // silently (e.g. SPCC without a catalog, MGC without MARS coverage). undefined = ran.
   if ( command.targetView ) {
      var view = findViewById( command.targetView );
      if ( !view ) throw new Error( "View not found: " + command.targetView );
      var executed = P.executeOn( view, keepHistory );
      var declined = (executed === false);
      return { status: "success", outputs: { processId: processId, applied: applied, executed: !declined },
               message: processId + (declined ? " DECLINED (executeOn returned false, no change applied) on " : " executed on ") + command.targetView +
                        (applied.length ? " [" + applied.join( ", " ) + "]" : " (defaults)") };
   }
   var executedG = P.executeGlobal();
   var declinedG = (executedG === false);
   return { status: "success", outputs: { processId: processId, applied: applied, executed: !declinedG },
            message: processId + (declinedG ? " DECLINED (executeGlobal returned false, no change applied) globally" : " executed globally") +
                     (applied.length ? " [" + applied.join( ", " ) + "]" : " (defaults)") };
}

function handleGetProcessParameters( command ) {
   var processId = (command.parameters || {}).processId;
   var P = instantiateProcess( processId );
   var params = {};
   for ( var k in P )
      if ( typeof P[k] !== "function" )
         params[k] = P[k];
   return { status: "success", outputs: { processId: processId, parameters: params },
            message: processId + ": " + Object.keys( params ).length + " parameter(s)" };
}

// Execute a process icon from the workspace by its icon id.
function handleRunProcessIcon( command ) {
   var iconName = (command.parameters || {}).iconName;
   if ( !iconName ) throw new Error( "iconName is required" );
   var P = ProcessInstance.fromIcon( iconName );
   if ( !P ) throw new Error( "Process icon not found: " + iconName );
   if ( command.targetView ) {
      var view = findViewById( command.targetView );
      if ( !view ) throw new Error( "View not found: " + command.targetView );
      var iexec = P.executeOn( view );
      return { status: "success", outputs: { iconName: iconName, executed: (iexec !== false) },
               message: "Icon " + iconName + (iexec === false ? " DECLINED on " : " executed on ") + command.targetView };
   }
   var iexecG = P.executeGlobal();
   return { status: "success", outputs: { iconName: iconName, executed: (iexecG !== false) },
            message: "Icon " + iconName + (iexecG === false ? " DECLINED globally" : " executed globally") };
}

function handleRunScript( command ) {
   var code = command.parameters.code;
   try {
      var result = eval( code );
      return { status: "success",
               outputs: { returnValue: String( result !== undefined ? result : "Script executed." ) },
               message: "Script executed successfully" };
   } catch ( e ) {
      throw new Error( "Script error: " + errMessage( e ) );
   }
}

// ============================================================================
// Session / process-history handlers (rev 2). Scripted executeOn accumulates an
// undoable process history; ImageWindow.undo()/redo() and view.historyIndex/
// canGoBackward work across bridge commands. Ported from the reference watcher.
// ============================================================================

function handleGetHistory( command ) {
   var w = resolveWindow( command.parameters.viewId );
   var v = w.mainView;
   return { status: "success",
            outputs: { historyIndex: v.historyIndex, canUndo: v.canGoBackward, canRedo: v.canGoForward },
            message: v.id + " history: index=" + v.historyIndex + " canUndo=" + v.canGoBackward + " canRedo=" + v.canGoForward };
}

function handleGetFullHistory( command ) {
   var w = resolveWindow( command.parameters.viewId );
   var v = w.mainView;
   var maxLines = command.parameters.maxParamLines || 12;
   var current = v.historyIndex;

   function innerIds( pc ) {
      var ids = [];
      try { for ( var k = 0; k < pc.length; ++k ) ids.push( pc.at( k ).processId() ); } catch ( e ) {}
      return ids;
   }
   function compactParams( p, limit ) {
      var out = [];
      try {
         var lines = String( p.toSource() ).split( "\n" );
         for ( var i = 0; i < lines.length; ++i ) {
            var ln = lines[i].replace( /^\s+/, "" );
            if ( ln.substring( 0, 2 ) === "P." || ln.substring( 0, 2 ) === "P[" ) {
               if ( ln.length > 200 ) ln = ln.substring( 0, 160 ) + " ...";
               out.push( ln );
               if ( out.length >= limit ) { out.push( "... (truncated)" ); break; }
            }
         }
      } catch ( e ) { out.push( "(source unavailable: " + e.message + ")" ); }
      return out;
   }

   var steps = [];
   var baseId = "(none)", baseInner = null;
   try {
      var init = v.initialProcessing;
      baseId = init.processId();
      if ( baseId === "ProcessContainer" ) baseInner = innerIds( init );
   } catch ( e ) {}
   steps.push({ index: 0, processId: baseId, inner: baseInner, params: [], applied: true, current: current === 0 });

   var c = v.processing, n = 0;
   try { n = c.length; } catch ( e ) { n = 0; }
   for ( var j = 0; j < n; ++j ) {
      var p = c.at( j );
      var pid = p.processId();
      var stateIndex = j + 1;
      steps.push({
         index: stateIndex, processId: pid,
         inner: (pid === "ProcessContainer") ? innerIds( p ) : null,
         params: compactParams( p, maxLines ),
         applied: stateIndex <= current, current: stateIndex === current
      });
   }
   return { status: "success",
            outputs: { historyIndex: current, stepCount: n, canUndo: v.canGoBackward, canRedo: v.canGoForward, steps: steps },
            message: v.id + " history: " + n + " step(s), current index=" + current };
}

function handleUndo( command ) {
   var w = resolveWindow( command.parameters.viewId );
   var v = w.mainView, steps = command.parameters.steps || 1, done = 0;
   for ( var i = 0; i < steps && v.canGoBackward; ++i ) { w.undo(); ++done; }
   return { status: "success",
            outputs: { undone: done, historyIndex: v.historyIndex, canUndo: v.canGoBackward, canRedo: v.canGoForward },
            message: "Undid " + done + " step(s) on " + v.id };
}

function handleRedo( command ) {
   var w = resolveWindow( command.parameters.viewId );
   var v = w.mainView, steps = command.parameters.steps || 1, done = 0;
   for ( var i = 0; i < steps && v.canGoForward; ++i ) { w.redo(); ++done; }
   return { status: "success",
            outputs: { redone: done, historyIndex: v.historyIndex, canUndo: v.canGoBackward, canRedo: v.canGoForward },
            message: "Redid " + done + " step(s) on " + v.id };
}

function handleSnapshot( command ) {
   var w = resolveWindow( command.parameters.viewId );
   var viewId = w.mainView.id;
   var snapId = command.parameters.snapshotId || (viewId + "_snap");
   var src = w.mainView.image;
   var ex = ImageWindow.windowById( snapId );
   if ( !ex.isNull ) ex.forceClose();
   var sw = new ImageWindow( src.width, src.height, src.numberOfChannels, src.bitsPerSample, src.isReal, src.isColor, snapId );
   var sv = sw.mainView;
   sv.beginProcess();
   sv.image.assign( src );
   sv.endProcess();
   return { status: "success",
            outputs: { snapshotId: snapId, width: src.width, height: src.height, channels: src.numberOfChannels },
            message: "Snapshot " + snapId + " taken from " + viewId };
}

function handleRestore( command ) {
   var w = resolveWindow( command.parameters.viewId );
   var snapId = command.parameters.snapshotId;
   var sw = ImageWindow.windowById( snapId );
   if ( sw.isNull ) throw new Error( "Snapshot not found: " + snapId );
   var tv = w.mainView, ti = tv.image, si = sw.mainView.image;
   if ( ti.width !== si.width || ti.height !== si.height || ti.numberOfChannels !== si.numberOfChannels )
      throw new Error( "Geometry mismatch: target vs snapshot" );
   tv.beginProcess();
   tv.image.assign( si );
   tv.endProcess();
   return { status: "success", outputs: { restored: true, historyIndex: tv.historyIndex },
            message: "Restored " + tv.id + " from snapshot " + snapId };
}

// ============================================================================
// Command Router
// ============================================================================

function routeCommand( command ) {
   var tool = command.tool;

   if ( command.timestamp ) {
      var age = Date.now() - Date.parse( command.timestamp );
      if ( isFinite( age ) && age > STALE_COMMAND_MS )
         throw new Error( "Stale command refused (queued " + Math.round( age / 60000 ) +
                          " min ago, limit " + (STALE_COMMAND_MS / 60000) + "); re-issue if still wanted." );
   }

   switch ( tool ) {
      case "list_open_images":       return handleListOpenImages( command );
      case "active_image":           return handleActiveImage( command );
      case "open_image":             return handleOpenImage( command );
      case "save_image":             return handleSaveImage( command );
      case "close_image":            return handleCloseImage( command );
      case "get_image_statistics":   return handleGetImageStatistics( command );
      case "run_process":            return handleRunProcess( command );
      case "get_process_parameters": return handleGetProcessParameters( command );
      case "run_process_icon":       return handleRunProcessIcon( command );
      case "run_script":             return handleRunScript( command );
      case "get_history":            return handleGetHistory( command );
      case "get_full_history":       return handleGetFullHistory( command );
      case "undo":                   return handleUndo( command );
      case "redo":                   return handleRedo( command );
      case "snapshot":               return handleSnapshot( command );
      case "restore":                return handleRestore( command );
      default:                       throw new Error( "Unknown tool: " + tool );
   }
}

function dispatchCommand( command ) {
   var result = routeCommand( command );
   if ( !result.outputs ) result.outputs = {};
   result.outputs.watcherRev = WATCHER_REVISION;
   return result;
}

// ============================================================================
// Main Polling Loop
// ============================================================================

function processNextCommand() {
   var files = listJsonFiles( COMMANDS_DIR + "/*.json" );
   if ( files.length === 0 )
      return false;
   files.sort();

   var filePath = files[0];
   var command;
   try {
      command = JSON.parse( readTextFile( filePath ) );
   } catch ( e ) {
      console.criticalln( "[AstroPilot] Failed to parse command file: " + filePath + " - " + e.message );
      deleteFile( filePath );
      return true;
   }

   var startTime = Date.now();
   var resultObj;
   try {
      console.writeln( "[AstroPilot] Executing: " + command.tool + " (id: " + command.id + ")" );
      var handlerResult = dispatchCommand( command );
      resultObj = {
         id: command.id, timestamp: getTimestamp(), status: handlerResult.status,
         process: command.process, duration_ms: Date.now() - startTime,
         outputs: handlerResult.outputs || {}, message: handlerResult.message || ""
      };
   } catch ( e ) {
      var msg = errMessage( e );
      console.criticalln( "[AstroPilot] Error executing " + command.tool + ": " + msg );
      resultObj = {
         id: command.id, timestamp: getTimestamp(), status: "error",
         process: command.process, duration_ms: Date.now() - startTime,
         error: { message: msg, type: (e && e.name) || "Error", stack: (e && e.stack) || "" }
      };
   }

   // Atomic result write: "<id>.tmp" (outside the *.json glob) then rename.
   var resultPath = RESULTS_DIR + "/" + command.id + ".json";
   var tmpPath = RESULTS_DIR + "/" + command.id + ".tmp";
   try {
      File.writeTextFile( tmpPath, JSON.stringify( resultObj ) );
      File.move( tmpPath, resultPath );
      console.writeln( "[AstroPilot] Result: " + resultObj.status + " (" + resultObj.duration_ms + "ms)" );
   } catch ( e ) {
      console.criticalln( "[AstroPilot] Failed to write result: " + e.message );
   }

   // Delete the command after writing the result. Crash window: a crash between execution
   // and this delete re-runs the command on restart (non-idempotent processes apply twice).
   deleteFile( filePath );
   return true;
}

function runWatcher() {
   ensureDirectory( BRIDGE_DIR );
   ensureDirectory( COMMANDS_DIR );
   ensureDirectory( RESULTS_DIR );
   ensureDirectory( LOGS_DIR );

   console.noteln( "===========================================" );
   console.noteln( "  AstroPilot Watcher v" + WATCHER_VERSION + " (rev " + WATCHER_REVISION + ")" );
   console.noteln( "  Bridge: " + BRIDGE_DIR );
   console.noteln( "  Idle poll ~" + POLL_INTERVAL_MS + "ms  |  Ctrl+F11 to abort" );
   console.noteln( "===========================================" );
   console.show();

   var SHUTDOWN_FILE = BRIDGE_DIR + "/shutdown";
   // Persistent latch: shouldShutdown() consumes (removes) the shutdown file, but it is called
   // from the inner sleep loops where a `break` only exits the INNER loop. Without a latch the
   // outer loop's top-check would then find the file already gone and keep polling forever
   // (the shutdown file appeared "consumed" but never stopped the watcher). Latching means any
   // detection — inner or outer — permanently trips shutdown so the outer loop reliably exits.
   var shuttingDown = false;
   function shouldShutdown() {
      if ( shuttingDown ) return true;
      if ( console.abortRequested ) { shuttingDown = true; return true; }
      if ( File.exists( SHUTDOWN_FILE ) ) {
         try { File.remove( SHUTDOWN_FILE ); } catch ( e ) {}
         shuttingDown = true;
         return true;
      }
      return false;
   }

   var commandCount = 0;
   for ( ;; ) {
      CoreApplication.processEvents();
      if ( shouldShutdown() ) {
         console.warningln( "[AstroPilot] Shutdown requested. Stopping." );
         break;
      }
      if ( processNextCommand() ) {
         commandCount++;
         for ( var y = 0; y < 20; ++y ) {
            CoreApplication.processEvents();
            System.msleep( 20 );
            if ( shouldShutdown() ) break;
         }
      } else {
         for ( var i = 0; i < 25; ++i ) {
            System.msleep( 20 );
            CoreApplication.processEvents();
            if ( shouldShutdown() ) break;
         }
      }
   }
   console.noteln( "[AstroPilot] Stopped. Processed " + commandCount + " command(s)." );
}

runWatcher();
