using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using Newtonsoft.Json;
using System.Linq;
using Newtonsoft.Json.Linq;

namespace Oliver4.DataverseModelDesigner.Model
{
    /// <summary>What a load produced, plus anything the user should be told about it.</summary>
    public class DiagramLoadResult
    {
        public DiagramDocument Document { get; set; }

        /// <summary>Set when the file was written by an older format and upgraded on the way in.</summary>
        public int UpgradedFromVersion { get; set; }

        /// <summary>Plain-language notes about the load, shown to the user as a warning toast.</summary>
        public List<string> Notes { get; set; } = new List<string>();
    }

    /// <summary>
    /// Reads and writes .dvmd diagram files. The format is UTF-8 JSON, deliberately plain text so
    /// a diagram can go into source control and be diffed alongside the solution it documents.
    ///
    /// Every failure here is something a user can actually hit - a file open in another program, a
    /// read-only folder, a half-copied file, a diagram from a newer build - so each one is turned
    /// into a sentence that says what happened and what to do about it, rather than an exception
    /// message that only means something to a developer.
    /// </summary>
    public static class DiagramFile
    {
        public const string Extension = ".dvmd";
        public const string FilterText = "Dataverse model diagram (*.dvmd)|*.dvmd|All files (*.*)|*.*";

        /// <summary>
        /// A diagram of a few hundred tables is well under a megabyte. Anything past this is either
        /// not a diagram or is corrupt, and reading it whole into memory helps nobody.
        /// </summary>
        private const long MaxFileBytes = 64L * 1024 * 1024;

        public static readonly JsonSerializerSettings SerializerSettings = new JsonSerializerSettings
        {
            Formatting = Formatting.Indented,
            NullValueHandling = NullValueHandling.Ignore,
            DateTimeZoneHandling = DateTimeZoneHandling.Utc,
            DateFormatHandling = DateFormatHandling.IsoDateFormat
        };

        public static string Serialize(DiagramDocument document)
        {
            if (document == null) throw new ArgumentNullException(nameof(document));
            document.ModifiedUtc = DateTime.UtcNow;
            document.FormatVersion = DiagramDocument.CurrentFormatVersion;
            return JsonConvert.SerializeObject(document, SerializerSettings);
        }

        public static DiagramDocument Deserialize(string json)
        {
            return DeserializeWithNotes(json).Document;
        }

        public static DiagramLoadResult DeserializeWithNotes(string json)
        {
            if (string.IsNullOrWhiteSpace(json))
                throw new InvalidDataException("This diagram file is empty. There is nothing in it to open.");

            JObject root;
            try
            {
                // DateParseHandling.None. Newtonsoft's default rewrites any string whose whole
                // value reads as an ISO-8601 date-time into a DateTime token, so a sticky note, a
                // description or a set of column notes reading "2026-06-30T09:00:00Z" came back as
                // "06/30/2026 09:00:00" - shifted to UTC if it carried an offset, and stripped of
                // sub-second precision. It was destructive on load and again on every save. The
                // genuinely typed properties (createdUtc, modifiedUtc, source.lastRefreshUtc) are
                // unaffected: this only changes how untyped tokens are read.
                using (var reader = new JsonTextReader(new StringReader(json))
                {
                    DateParseHandling = DateParseHandling.None
                })
                {
                    root = JObject.Load(reader);
                }
            }
            catch (JsonException ex)
            {
                throw new InvalidDataException(
                    "This file is not a readable Dataverse model diagram. It may have been edited by " +
                    "hand, copied while it was being written, or saved by a different program. (" +
                    ex.Message + ")", ex);
            }

            // A .dvmd always carries a tables array. Checking for it turns "picked the wrong file"
            // into a sentence about the file rather than a stack of null-reference symptoms later.
            if (root["tables"] == null && root["relationships"] == null)
            {
                throw new InvalidDataException(
                    "This file is valid JSON but does not look like a diagram - it has no tables or " +
                    "relationships in it. Check you picked the right file.");
            }

            // Absent is not the same as present-and-1. This tool always stamps the version, so a
            // file without one was written by something else, and telling the user it was upgraded
            // "from file format 1" states a guess as fact.
            var versionToken = root["formatVersion"];
            var versionRecorded = versionToken != null && versionToken.Type != JTokenType.Null;

            // Cast in its own try: a formatVersion holding a string, an object or an array throws
            // FormatException or ArgumentException, neither of which derives from JsonException,
            // so it would escape every friendly-error wrapper in this method and reach the user as
            // a raw .NET message.
            int fileVersion;
            try
            {
                fileVersion = (int?)versionToken ?? 1;
            }
            catch (Exception ex)
            {
                throw new InvalidDataException(
                    "This diagram's format version is not a whole number, so the file cannot be " +
                    "read. It has probably been edited by hand.", ex);
            }

            if (fileVersion < 1)
            {
                throw new InvalidDataException(
                    "This diagram claims format version " + fileVersion + ", which is not a version " +
                    "this tool has ever written.");
            }

            if (fileVersion > DiagramDocument.CurrentFormatVersion)
            {
                throw new InvalidDataException(
                    "This diagram was saved by a newer version of Dataverse Model Designer (file format " +
                    fileVersion + "; this build reads up to " + DiagramDocument.CurrentFormatVersion +
                    "). Update the tool to open it.");
            }

            var result = new DiagramLoadResult();
            if (fileVersion < DiagramDocument.CurrentFormatVersion)
            {
                Upgrade(root, fileVersion, versionRecorded, result);
                result.UpgradedFromVersion = fileVersion;
            }

            DiagramDocument document;
            try
            {
                document = root.ToObject<DiagramDocument>(JsonSerializer.Create(SerializerSettings));
            }
            catch (JsonException ex)
            {
                throw new InvalidDataException(
                    "This diagram could not be read. One of its values is not the shape the tool " +
                    "expects: " + ex.Message, ex);
            }

            if (document == null)
                throw new InvalidDataException("This diagram file could not be read.");

            Normalise(document, result);
            result.Document = document;
            return result;
        }

        /// <summary>
        /// Brings an older file up to the current format in place, on the raw JSON, before it is
        /// turned into objects. Working on the JObject means a property that no longer exists on
        /// the model can still be read here and translated, which is the whole point of a migration.
        /// Each step upgrades by exactly one version so the chain composes.
        ///
        /// <paramref name="versionRecorded"/> says whether the file actually carried a
        /// formatVersion, so the note can tell the user what was read rather than assert a version
        /// the file never claimed.
        /// </summary>
        private static void Upgrade(JObject root, int fromVersion, bool versionRecorded, DiagramLoadResult result)
        {
            if (fromVersion < 2)
            {
                // Version 1 -> 2. The only removal is displayProfile, a named bundle of display
                // settings that no UI had read since 1.1. The individual toggles it used to imply
                // are all still present and are what the canvas actually renders from, so dropping
                // the property loses nothing a user could see.
                var settings = root["settings"] as JObject;
                if (settings != null && settings["displayProfile"] != null)
                {
                    settings.Remove("displayProfile");
                }

                // Note text colour, likewise: written by every version 1 build, read by none of
                // them. Note text has always been drawn in the theme's ink so it stays legible
                // when the canvas switches between light and dark.
                var annotations = root["annotations"] as JArray;
                if (annotations != null)
                {
                    foreach (var annotation in annotations.OfType<JObject>())
                        annotation.Remove("colour");
                }

                result.Notes.Add(versionRecorded
                    ? "Upgraded from file format 1. Saving will write format 2, which older builds of " +
                      "the tool cannot open."
                    : "This diagram did not record a file format version, so it has been read as the " +
                      "oldest format. Saving will write format 2, which older builds of the tool " +
                      "cannot open.");
            }

            root["formatVersion"] = DiagramDocument.CurrentFormatVersion;
        }

        /// <summary>
        /// Writes the diagram, never leaving the user with less than they started with.
        ///
        /// The content goes to a sibling temporary file first, then replaces the original in one
        /// step. An earlier version deleted the original and then moved the temporary into its
        /// place, with a finally block that tidied the temporary away - so a move that failed
        /// between those two lines destroyed the original *and* the replacement, while telling the
        /// user the file was merely "open in another program". File.Replace is the operation that
        /// actually gives the guarantee the delete-then-move pair only appeared to.
        /// </summary>
        public static void Save(DiagramDocument document, string path)
        {
            var json = Serialize(document);

            var directory = Path.GetDirectoryName(path);
            var folder = string.IsNullOrEmpty(directory) ? "." : directory;
            var stamp = Guid.NewGuid().ToString("N").Substring(0, 8);

            // Short fixed sidecar names rather than the destination file name plus a suffix. The
            // old names were 16 and 18 characters longer than a path the Save dialog had already
            // accepted, so a destination of around 250 characters failed on a name the user never
            // chose - and net48 surfaces that as DirectoryNotFoundException or
            // PathTooLongException, both of which read as a problem with the folder or the drive.
            var temporary = Path.Combine(folder, "~dvmd" + stamp + ".tmp");
            var backup = Path.Combine(folder, "~dvmd" + stamp + ".bak");

            var replaced = false;

            try
            {
                File.WriteAllText(temporary, json, new UTF8Encoding(false));

                if (File.Exists(path))
                {
                    // Atomic on NTFS, and the backup means even a failure inside Replace leaves a
                    // recoverable copy on disk rather than nothing.
                    File.Replace(temporary, path, backup, ignoreMetadataErrors: true);
                }
                else
                {
                    File.Move(temporary, path);
                }

                replaced = true;
            }
            catch (UnauthorizedAccessException ex)
            {
                throw new IOException(
                    "Cannot write to " + path + ". The file or folder is read-only, or your account " +
                    "does not have permission to write there." + RescueAdvice(path, temporary, backup) +
                    " Try Save as and pick another folder.", ex);
            }
            catch (DirectoryNotFoundException ex)
            {
                throw new IOException(
                    "The folder for " + path + " no longer exists." +
                    RescueAdvice(path, temporary, backup) +
                    " Use Save as and pick a folder that does.", ex);
            }
            catch (PathTooLongException ex)
            {
                // Ahead of the IOException catch: PathTooLongException derives from it, and the
                // generic message would blame the drive for a path length the user can fix.
                throw new IOException(
                    "The full path to " + path + " is too long for Windows." +
                    RescueAdvice(path, temporary, backup) +
                    " Use Save as and pick a folder closer to the root of the drive, or shorten the " +
                    "file name.", ex);
            }
            catch (IOException ex)
            {
                throw new IOException(
                    "Could not save to " + path + ". The file may be open in another program, or the " +
                    "drive may be full or disconnected." + RescueAdvice(path, temporary, backup) +
                    " (" + ex.Message + ")", ex);
            }
            finally
            {
                // Only ever tidied up once the replacement has actually happened. Deleting the
                // temporary on the failure path would throw away the one complete copy of the
                // user's work that survived.
                if (replaced)
                {
                    TryDelete(backup);
                    TryDelete(temporary);
                }
            }
        }

        public static DiagramDocument Load(string path)
        {
            return LoadWithNotes(path).Document;
        }

        public static DiagramLoadResult LoadWithNotes(string path)
        {
            if (string.IsNullOrWhiteSpace(path))
                throw new ArgumentException("No file was chosen.", nameof(path));

            string text;
            try
            {
                var info = new FileInfo(path);

                if (!info.Exists)
                {
                    throw new FileNotFoundException(
                        "The diagram " + path + " no longer exists. It may have been moved, renamed or " +
                        "deleted since it was last opened.", path);
                }

                if (info.Length == 0)
                    throw new InvalidDataException("The diagram " + path + " is an empty file.");

                if (info.Length > MaxFileBytes)
                {
                    throw new InvalidDataException(
                        "The file " + path + " is far larger than any diagram should be (" +
                        (info.Length / (1024 * 1024)) + " MB), so it has not been opened.");
                }

                text = File.ReadAllText(path, Encoding.UTF8);
            }
            catch (UnauthorizedAccessException ex)
            {
                throw new IOException(
                    "Cannot read " + path + ". Your account does not have permission to open it.", ex);
            }
            catch (IOException ex) when (!(ex is FileNotFoundException))
            {
                throw new IOException(
                    "Could not read " + path + ". The file may be open and locked by another program, " +
                    "or on a drive that is no longer connected. (" + ex.Message + ")", ex);
            }

            return DeserializeWithNotes(text);
        }

        /// <summary>
        /// What to tell the user about the files a failed save has left on disk.
        ///
        /// Keeping the temporary file on the failure path is deliberate - it is often the only
        /// complete copy of the work - but a file nobody is told about is just clutter that
        /// accumulates one per failed save, so its name goes into the message. File.Replace also
        /// has a rare state (ERROR_UNABLE_TO_MOVE_REPLACEMENT_2) where the original survives only
        /// under the backup name: there the diagram on disk genuinely has changed, and saying it
        /// has not would send the user looking for a file that is no longer where they left it.
        /// </summary>
        private static string RescueAdvice(string path, string temporary, string backup)
        {
            var advice = new StringBuilder();

            if (!File.Exists(path) && File.Exists(backup))
            {
                advice.Append(" " + path + " is no longer there: the version that was in its place " +
                    "has been left as " + backup + ", so rename that back to recover it.");
            }
            else
            {
                advice.Append(" Your diagram has not been changed.");
            }

            if (File.Exists(temporary))
            {
                advice.Append(" A complete copy of the work you were saving is at " + temporary + ".");
            }

            return advice.ToString();
        }

        private static void TryDelete(string path)
        {
            try
            {
                if (File.Exists(path)) File.Delete(path);
            }
            catch (Exception ex)
            {
                // A leftover .saving- file is untidy but harmless, and is never the reason to fail
                // a save that otherwise worked.
                System.Diagnostics.Trace.WriteLine(
                    "Dataverse Model Designer: could not remove temporary file " + path + ": " + ex.Message);
            }
        }

        /// <summary>
        /// Fills in anything an older or hand-edited file may be missing so the rest of the
        /// codebase can assume non-null collections.
        /// </summary>
        private static void Normalise(DiagramDocument document, DiagramLoadResult result)
        {
            if (document.Settings == null) document.Settings = new DiagramSettings();
            if (document.View == null) document.View = new ViewState();
            if (document.Source == null) document.Source = new DiagramSource();
            if (document.Tables == null) document.Tables = new List<DiagramTable>();
            if (document.Relationships == null) document.Relationships = new List<DiagramRelationship>();
            if (document.Annotations == null) document.Annotations = new List<DiagramAnnotation>();

            if (document.View.Zoom <= 0) document.View.Zoom = 1.0;

            // The legend position is a pair or it is nothing. Half of it - or a value a hand edit
            // has made meaningless - would otherwise be read as a real position and the legend
            // would be drawn against the top-left inset with no way to tell why. Null is the
            // corner it has always sat in.
            var legendX = document.Settings.LegendX;
            var legendY = document.Settings.LegendY;

            if (!legendX.HasValue || !legendY.HasValue ||
                double.IsNaN(legendX.Value) || double.IsNaN(legendY.Value) ||
                double.IsInfinity(legendX.Value) || double.IsInfinity(legendY.Value))
            {
                document.Settings.LegendX = null;
                document.Settings.LegendY = null;
            }

            foreach (var table in document.Tables)
            {
                if (table.Columns == null) table.Columns = new List<DiagramColumn>();
                if (table.AlternateKeys == null) table.AlternateKeys = new List<AlternateKeyInfo>();
                if (string.IsNullOrEmpty(table.Id)) table.Id = Guid.NewGuid().ToString("N");
                foreach (var column in table.Columns)
                {
                    if (column.Targets == null) column.Targets = new List<string>();
                    if (string.IsNullOrEmpty(column.Id)) column.Id = Guid.NewGuid().ToString("N");
                }
            }

            foreach (var relationship in document.Relationships)
            {
                if (relationship.Waypoints == null) relationship.Waypoints = new List<PointD>();
                if (relationship.LookupTargets == null) relationship.LookupTargets = new List<string>();
                if (string.IsNullOrEmpty(relationship.Id)) relationship.Id = Guid.NewGuid().ToString("N");

                // Exclude was removed in 1.7.0 because it duplicated Hide: both kept the
                // relationship in the file, off the canvas and out of every export, and the two
                // controls sat next to each other doing the same thing. An excluded relationship
                // in an existing file becomes a hidden one, so the diagram still looks exactly as
                // its author left it while the flag they can no longer reach becomes inert.
                //
                // Additive normalisation, like the annotation kind below, so the file format
                // version is unchanged: hidden is a property every build back to format 1 already
                // wrote and read, so an older build opening the saved file draws the same picture.
                if (!relationship.Included)
                {
                    relationship.Hidden = true;
                    relationship.Included = true;
                }
            }

            foreach (var annotation in document.Annotations)
            {
                if (string.IsNullOrEmpty(annotation.Id)) annotation.Id = Guid.NewGuid().ToString("N");

                // Every annotation written before 1.6.0 has no kind, and every one of them was a
                // sticky note. Stamping it here means nothing downstream has to know that.
                //
                // Canonicalised rather than only filled in when blank: AnnotationKinds.Of matches
                // case-insensitively, but the canvas compares the stored string case-sensitively,
                // so a hand-edited {"kind":"Text"} was drawn as a sticky note and exported as a
                // text box - permanently, in a format meant to be hand-edited.
                annotation.Kind = AnnotationKinds.Of(annotation);
            }

            // A relationship whose ends were removed from the diagram by a hand edit would otherwise
            // sit in the file for ever, invisible and uneditable.
            var tableIds = new HashSet<string>(StringComparer.Ordinal);
            foreach (var table in document.Tables) tableIds.Add(table.Id);

            var pruned = document.Relationships.RemoveAll(r =>
                !string.IsNullOrEmpty(r.FromTableId) && !string.IsNullOrEmpty(r.ToTableId) &&
                (!tableIds.Contains(r.FromTableId) || !tableIds.Contains(r.ToTableId)));

            // Said out loud: dropping content silently leaves the user with a file that has quietly
            // lost part of their diagram. The id comparison is ordinal, so a case mismatch in a
            // hand-edited file prunes too, and the note is the only clue that is what happened.
            if (pruned > 0 && result != null)
            {
                result.Notes.Add(
                    pruned + " relationship(s) were removed because the tables they joined are not " +
                    "in this file.");
            }
        }
    }
}
