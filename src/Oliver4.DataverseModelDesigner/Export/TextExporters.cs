using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using Oliver4.DataverseModelDesigner.Model;

namespace Oliver4.DataverseModelDesigner.Export
{
    /// <summary>Mermaid erDiagram output, for wikis and markdown documentation.</summary>
    public static class MermaidExporter
    {
        public static ExportProduct Export(DiagramDocument document)
        {
            var warnings = new List<string>
            {
                "Mermaid renders relationships and columns only. Manual layout, highlights, notes and colours are not carried over."
            };

            var builder = new StringBuilder();
            builder.AppendLine("---");
            builder.AppendLine("title: " + YamlString(document.Title ?? "Dataverse model"));
            builder.AppendLine("---");
            builder.AppendLine("erDiagram");

            var names = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var table in document.Tables)
                names[table.Id] = MermaidName(table, names.Values);

            foreach (var relationship in document.Relationships.Where(r => r.Included && !r.Hidden))
            {
                string from, to;
                if (!names.TryGetValue(relationship.FromTableId ?? string.Empty, out from)) continue;
                if (!names.TryGetValue(relationship.ToTableId ?? string.Empty, out to)) continue;

                var label = relationship.SchemaName ?? relationship.DisplayName ?? "relates to";
                if (relationship.Status == ObjectStatus.Proposed) label = "proposed: " + label;

                builder.AppendLine("    " + from + " " + Notation(relationship) + " " + to +
                                   " : \"" + label.Replace("\"", "'") + "\"");
            }

            foreach (var table in document.Tables)
            {
                // Through SelectedColumns, which applies the collapsed rule and the column order as
                // well as the detail mode. Calling SelectColumns directly skipped both, so a
                // collapsed card - which the canvas draws as a name and nothing else - came out of
                // Mermaid with every one of its columns on it. The documentation export embeds this
                // diagram beside prose saying that table shows no columns, so one document said
                // both things about the same table.
                var rows = ExportRowBuilder.SelectedColumns(document, table).ToList();

                // A table with no drawn columns still belongs in the picture. Skipping the entity
                // dropped it from the diagram altogether - in Tables-only mode, or for a collapsed
                // card, a table with no drawn relationship was simply not there - while the
                // documentation's Tables section still listed it and the summary still counted it.
                // Mermaid accepts an empty attribute block and draws the bare box the canvas draws.
                builder.AppendLine("    " + names[table.Id] + " {");
                foreach (var column in rows)
                {
                    var type = MermaidToken(column.TypeName ?? column.AttributeType ?? "string");
                    var name = MermaidToken(column.LogicalName ?? column.SchemaName ?? column.DisplayName ?? "column");
                    var key = column.IsPrimaryId ? " PK"
                        : column.IsLookup ? " FK"
                        : column.IsAlternateKey ? " UK"
                        : string.Empty;
                    var comment = column.Status == ObjectStatus.Existing
                        ? string.Empty
                        : " \"" + column.Status.ToString().ToLowerInvariant() + "\"";

                    builder.AppendLine("        " + type + " " + name + key + comment);
                }
                builder.AppendLine("    }");
            }

            if (document.Tables.Any(t => t.Status != ObjectStatus.Existing))
                warnings.Add("Proposed, external and deprecated status is written as a Mermaid comment on each column rather than as a distinct style.");

            return new ExportProduct { Text = builder.ToString(), Warnings = warnings };
        }

        private static string Notation(DiagramRelationship relationship)
        {
            var line = relationship.Status == ObjectStatus.Existing ? "--" : "..";

            switch (relationship.Kind)
            {
                case RelationshipKind.ManyToMany: return "}o" + line + "o{";
                case RelationshipKind.ManyToOne: return "}o" + line + "||";
                default: return "||" + line + "o{";
            }
        }

        private static string MermaidName(DiagramTable table, IEnumerable<string> taken)
        {
            var baseName = MermaidToken(table.LogicalName ?? table.SchemaName ?? table.DisplayName ?? "table").ToUpperInvariant();
            var existing = new HashSet<string>(taken, StringComparer.OrdinalIgnoreCase);
            if (!existing.Contains(baseName)) return baseName;

            var suffix = 2;
            while (existing.Contains(baseName + "_" + suffix)) suffix++;
            return baseName + "_" + suffix;
        }

        /// <summary>
        /// The front-matter title as a double-quoted YAML scalar.
        ///
        /// Written raw, a perfectly ordinary diagram title broke the document: "Phase 2: target
        /// model" produced `title: Phase 2: target model`, which is not valid YAML, so mermaid
        /// refused to render either the .mmd or the ```mermaid block the Markdown document embeds.
        /// A leading # lost the title as a comment and a newline ended the front matter early.
        /// </summary>
        private static string YamlString(string value)
        {
            var escaped = (value ?? string.Empty)
                .Replace("\\", "\\\\")
                .Replace("\"", "\\\"")
                .Replace("\r", "\\r")
                .Replace("\n", "\\n");

            return "\"" + escaped + "\"";
        }

        private static string MermaidToken(string value)
        {
            var cleaned = Regex.Replace(value ?? string.Empty, "[^A-Za-z0-9_]", "_").Trim('_');
            if (cleaned.Length == 0) cleaned = "item";
            if (char.IsDigit(cleaned[0])) cleaned = "_" + cleaned;
            return cleaned;
        }
    }
}
