var builder = WebApplication.CreateBuilder(args);

var app = builder.Build();

// Resolve the watched photos folder from config (expands a leading "~").
var configured = app.Configuration["Lifetime:PhotosFolder"] ?? "~/Pictures/lifetime-rolls";
var photosFolder = configured.StartsWith('~')
    ? Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        configured.TrimStart('~').TrimStart('/', '\\'))
    : configured;

app.Logger.LogInformation("Watching photos folder: {Folder}", photosFolder);

// Serve the built front end (src/web -> wwwroot) when present.
app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet("/api/health", () => Results.Ok(new
{
    status = "ok",
    app = "lifetime",
    photosFolder
}));

// SPA fallback: any non-API route returns index.html.
app.MapFallbackToFile("index.html");

app.Run();
