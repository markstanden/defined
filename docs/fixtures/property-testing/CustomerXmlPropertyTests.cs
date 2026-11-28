using System;
using System.Globalization;
using FsCheck;
using FsCheck.Fluent;
using FsCheck.Xunit;
using Microsoft.FSharp.Core;
using Shouldly;
using Xunit;

/// <summary>
/// The customer XML round-trip family (AB#1234). The named edges in
/// <see cref="CustomerXmlTests"/> keep the empty and hostile inputs; the law
/// covers the rest of the documented domain.
/// </summary>
public sealed class CustomerXmlPropertyTests
{
    /// <summary>
    /// The documented round trip: every valid customer survives render then
    /// parse unchanged.
    /// </summary>
    [Property(Arbitrary = [typeof(CustomerArbitraries)])]
    public void RenderThenParse_ForAnyValidCustomer_RestoresOriginal(Customer original)
    {
        // Act
        bool restored = RoundTrips(CustomerXml.Render, CustomerXml.Parse, original);

        // Assert
        restored.ShouldBeTrue($"render then parse must restore {original}");
    }

    // Why use multi-statement-act here: the control and the mutant are the canary's two halves
    [Fact]
    public void RenderThenParse_WhenTheImplementationIsMutated_IsFalsified()
    {
        // Arrange
        Customer original = new(1, "Alan");

        // Act
        bool realRestores = RoundTrips(CustomerXml.Render, CustomerXml.Parse, original);
        bool uppercasingParseRestores = RoundTrips(CustomerXml.Render, UppercasingParse, original);

        // Assert
        realRestores.ShouldBeTrue("the control proves the real implementation satisfies the law");
        uppercasingParseRestores.ShouldBeFalse("the name clause must reject a parse that changes case");
    }

    /// <summary>Mutant: uppercases the name, so the name clause must reject it.</summary>
    private static Customer UppercasingParse(string xml)
    {
        Customer parsed = CustomerXml.Parse(xml);
        return parsed with { Name = parsed.Name.ToUpperInvariant() };
    }

    [Theory]
    [MemberData(nameof(CustomerXmlSeeds.All), MemberType = typeof(CustomerXmlSeeds))]
    public void RenderThenParse_WhenReplayingARecordedSeed_RestoresOriginal(SeedCase seed)
    {
        // Arrange
        string[] parts = seed.Seed.Split(',');
        ulong seedValue = ulong.Parse(parts[0], CultureInfo.InvariantCulture);
        ulong gamma = ulong.Parse(parts[1], CultureInfo.InvariantCulture);
        Replay replay = new(new Rnd(seedValue, gamma), null);
        Property law = Prop.ForAll(
            CustomerArbitraries.ValidCustomer(),
            (Customer original) => RoundTrips(CustomerXml.Render, CustomerXml.Parse, original));

        // Act / Assert
        Check.One(Config.QuickThrowOnFailure.WithReplay(FSharpOption<Replay>.Some(replay)), law);
    }

    /// <summary>
    /// The round-trip law: for any customer the pair admits, rendering and
    /// parsing returns the original.
    /// </summary>
    private static bool RoundTrips(
        Func<Customer, string> render,
        Func<string, Customer> parse,
        Customer original) =>
        parse(render(original)) == original;
}
