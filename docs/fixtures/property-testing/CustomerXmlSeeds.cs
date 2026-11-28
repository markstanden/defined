using System;
using Xunit;

public readonly record struct SeedCase(string Seed, DateOnly Found, string Ticket, string Symptom);

public static class CustomerXmlSeeds
{
    public static readonly TheoryDataRow<SeedCase>[] All =
    [
        new(new("1234567890,987654321", new DateOnly(2026, 11, 27), "AB#1234", "name uppercased"))
    ];
}
