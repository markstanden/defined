# Property-based tests (C# / FsCheck)

This is the shape to write when a contract states a law. It is written for an
engineer who has used `[Fact]` and `[Theory]` and is new to generated inputs.
The worked example is a round-trip law; the rules it applies are in
[`test-review.md`](test-review.md). The snippets use FsCheck 3's Fluent API:
add the `FsCheck` package and `FsCheck.Xunit` (or `FsCheck.Xunit.v3` on xUnit
v3).

> One law per method; the generated input is a typed parameter; the generator
> and the seed stay outside the law; a named example stays beside it. The rest
> of this page says why.

## Why a property test

An example test says: for this input, this output. A table says: for these N
inputs, these outputs. A property says: for every input the contract allows,
this relationship holds.

That buys two things:

- **the long tail** — generated inputs reach combinations nobody typed into a
  table;
- **the smallest counterexample** — when one fails, the framework shrinks the
  input to the simplest case that still fails, which is usually the boundary
  the contract cares about.

It costs one thing: a property is only as good as its generator. A property
over inputs the contract never promised proves nothing, and a law copied from
the implementation proves only that the implementation agrees with itself. The
law and the generator come from the documented contract, not from the code
under test.

## What FsCheck does

`[Property]` is FsCheck's test attribute. When the test runner sees it:

1. it reads the method's parameters and generates a value for each one;
2. it calls the method once per generated case (100 cases by default), plus
   shrinking attempts when one fails;
3. an assertion failure ends the run, and FsCheck shrinks the input to the
   smallest failing case;
4. the failure prints the shrunk case and the replay seed, so the run can be
   repeated exactly.

The generated parameter is the arrangement. That is why the readable test has
no `// Arrange` block: there is no setup for the reader to follow.

## The shape that is hard to read

This is the shape generated tests often arrive in. It is not wrong because it
uses FsCheck; it is hard because five ideas are tangled in one method:

```csharp
[Property(Replay = "20261122,1")]
public Property CustomerXml_Works()
{
    return Prop.ForAll(
        Arb.From(Gen.Elements(
            new Customer(1, "Ada"),
            new Customer(2, "Grace"))),
        customer => CustomerXml.Parse(CustomerXml.Render(customer)).Name ==
            customer.Name && customer.Id > 0);
}
```

- the name says nothing about the law;
- the generated input type is buried in a lambda;
- the generator is built inside the test, so the domain is invisible;
- two claims share one `&&`, so the failure cannot say which one broke;
- the seed is a literal, so the world never rotates and the reader cannot tell
  whether it matters.

## The law

Read the shape below as a sentence: for any valid customer, rendering and then
parsing returns the original customer.

```csharp
using FsCheck.Xunit;
using Shouldly;

public sealed class CustomerXmlPropertyTests
{
    [Property(Arbitrary = [typeof(CustomerArbitraries)])]
    public void RenderThenParse_ForAnyValidCustomer_RestoresOriginal(Customer original)
    {
        // Act
        string xmlRenderedCustomer = CustomerXml.Render(original);
        Customer reparsed = CustomerXml.Parse(xmlRenderedCustomer);

        // Assert
        reparsed.ShouldBe(original);
    }
}
```

Every part earns its place:

- `RenderThenParse_ForAnyValidCustomer_RestoresOriginal` names the operation,
  the domain and the law. A failure in CI names the contract before anyone
  opens the file.
- `Customer original` is the generated input, with its type visible. The reader
  does not have to infer the domain from a lambda.
- The two `Act` statements are one behaviour: a round trip is an operation with
  two halves. Moving the render into `Arrange` would hide that the render is
  part of what is being tested.
- One `ShouldBe` makes the failure name the law and show both values. Two
  assertions, or an `&&`, would hide which half failed.
- There is no seed, generator or `Prop.ForAll` in the body. Those are
  infrastructure; the law is the only thing the reader should have to hold in
  their head.

The example spells out its types for the reader. That is deliberate here even
where the repository's style would allow `var`: the point of the first read is
to see what is generated and what is parsed.

## The domain type

```csharp
public sealed record Customer(int Id, string Name);
```

`Customer` is a `record` so `ShouldBe` compares values, not references. If the
production type is a class, give it value equality or compare a documented
projection in the assertion. A round-trip test that compares references fails
on every input and tells you nothing.

Equality must be value equality all the way down. A record holding a list or an
array still compares those members by reference; compare a documented snapshot
instead if that is the case.

The law also depends on the production pair it exercises — a `string
CustomerXml.Render(Customer customer)` and a `Customer CustomerXml.Parse(string
xml)`. They are omitted here because the page is about the test; a missing or
one-way pair is a production problem, not a property problem.

## The generator

```csharp
using System.Collections.Generic;
using FsCheck;
using FsCheck.Fluent;

public static class CustomerArbitraries
{
    /// <summary>A representative customer from the documented XML contract.</summary>
    public static Arbitrary<Customer> ValidCustomer()
    {
        Gen<string> name = Gen.Elements("Ada", "Grace", "Alan");
        Gen<int> id = Gen.Choose(1, 100_000);
        Gen<Customer> customer = from customerName in name
                                 from customerId in id
                                 select new Customer(customerId, customerName);
        return Arb.From(customer, ShrinkCustomer);
    }

    /// <summary>Shrinks the id to the documented minimum, staying inside the domain.</summary>
    private static IEnumerable<Customer> ShrinkCustomer(Customer customer)
    {
        if (customer.Id > 1)
        {
            yield return customer with { Id = 1 };
        }
    }
}
```

- `Arbitrary<Customer>` is the type FsCheck looks for when the method has a
  `Customer` parameter. `[Property(Arbitrary = [typeof(CustomerArbitraries)])]`
  registers it for the test method.
- `Gen<string>` and `Gen<int>` show the pieces; the query composes them into a
  `Customer`. The reader can see the documented domain without opening another
  file.
- `Arb.From(customer, ShrinkCustomer)` is the two-argument overload; the second
  argument is the shrinker. `Arb.From(customer)` alone registers no shrinker —
  FsCheck's API says so — and a property built on it never minimises a failure.
- `ShrinkCustomer` yields only values the contract accepts (`Id` of at least
  1), so shrinking never leaves the documented domain.
- `ValidCustomer` names the contract domain, not the type. If the contract also
  documents rejected values, a separate `InvalidCustomer` generator sits beside
  it and the test that expects rejection names that domain.
- The generator lives outside the test class so the law file stays a list of
  laws. The law never builds inputs.
- The name list is deliberately small to keep the page readable. A real
  generator follows the documented viable set, not a convenient sample.

Without the attribute's `typeof(...)`, FsCheck would invent a `Customer` from
its members. That is not the documented domain, so it does not prove the
contract.

## The seed

The seed is how a failing run is reproduced. It is routing, not evidence, and
it never appears in the law.

The suite does not pin a seed. FsCheck draws a fresh one on every run, local and
CI alike, and prints it with the shrunk case when a property fails.

A failure is a signal, not a flake: investigate it. Either the code is wrong,
the generator admits inputs the contract does not, or the law is too weak. Fix
that cause. Then record the seed and the promoted case so the same input guards
the suite forever. Pinning the seed to get green hides the defect and freezes
the sample; reproducibility comes from the printed seed and the recorded case,
not from a frozen run.

When a property fails, record the `(seed,gamma)` pair in a per-class ledger
beside the law, with the date, ticket and symptom:

```csharp
public readonly record struct SeedCase(string Seed, DateOnly Found, string Ticket, string Symptom);

public static class CustomerXmlSeeds
{
    public static readonly TheoryDataRow<SeedCase>[] All =
    [
        new(new("1234567890,987654321", new DateOnly(2026, 11, 27), "AB#1234", "name uppercased"))
    ];
}
```

Replay every entry through the same law body from one `[Theory]` beside the
random properties:

```csharp
using FsCheck;
using FsCheck.Fluent;
using Microsoft.FSharp.Core;
using Xunit;

[Theory]
[MemberData(nameof(CustomerXmlSeeds.All), MemberType = typeof(CustomerXmlSeeds))]
public void RenderThenParse_WhenReplayingARecordedSeed_RestoresOriginal(SeedCase seed)
{
    // Arrange
    string[] parts = seed.Seed.Split(',');
    Replay replay = new(new Rnd(ulong.Parse(parts[0]), ulong.Parse(parts[1])), null);
    Property law = Prop.ForAll(
        CustomerArbitraries.ValidCustomer(),
        (Customer original) =>
        {
            RestoresOriginal(original);
            return true;
        });

    // Act / Assert
    Check.One(Config.QuickThrowOnFailure.WithReplay(FSharpOption<Replay>.Some(replay)), law);
}
```

- `Replay` is `"seed,gamma"` and the gamma must be odd, because FsCheck rejects
  an even one. Parse both parts as `ulong`: a printed seed can exceed
  `long.MaxValue`. Record the two-element pair FsCheck prints first; a
  multi-test failure also prints a three-element last-step tuple, which adds the
  size and is not needed for this ledger.
- The ledger is `TheoryDataRow<SeedCase>[]` on xUnit v3, not `SeedCase[]`:
  xunit.v3's xUnit1019 analyzer rejects a plain struct array as `MemberData`.
  xUnit v2 has no `TheoryDataRow`; use `SeedCase[]` there.
- `Prop.ForAll` takes the `Arbitrary<T>` values, not their `.Generator`;
  `QuickThrowOnFailure` makes a replay failure throw so xUnit reports it.
- The property carries no `Replay`. A per-site literal freezes one property; the
  ledger holds every recorded seed and is the one place to add another.
- `RestoresOriginal` is the law body extracted from the `[Property]` method
  above, so the random property and the replay theory run the same assertions
  and a recorded seed cannot drift from the live law. The lambda returns `true`
  after the body because `Prop.ForAll` needs a testable result; the assertions
  throw on failure.
- The ledger sits beside the class it guards, not in `Support/`; a central list
  keyed by law name silently orphans entries on a rename.
- A ledger entry can go once a promoted example covers the same input and the
  law is unchanged. Otherwise the list grows without bound and stops being
  readable.

## Where the files live

```text
tests/
  Support/CustomerArbitraries.cs        the documented domains
  CustomerXmlTests.cs                   named examples
  CustomerXmlPropertyTests.cs           laws and the replay theory
  CustomerXmlSeeds.cs                   the per-class seed ledger
```

The split is the readability rule made physical. A reader who opens
`CustomerXmlPropertyTests.cs` sees laws and the ledger's replay theory; the
generator is in `Support/`, and the seed ledger sits beside the class it guards.

## What a failure looks like

A deliberate defect in `Parse` (uppercasing the name) produces something like:

```text
Falsifiable, after 1 test (1 shrink) (1234567890,987654321).
Original:
Customer { Id = 35276, Name = Alan }
Shrunk:
Customer { Id = 1, Name = Alan }

Shouldly.ShouldAssertException : reparsed
    should be
Customer { Id = 1, Name = Alan }
    but was
Customer { Id = 1, Name = ALAN }
```

This run stopped after one case because the first generated value already
failed; FsCheck then shrank it to the smallest failing customer, and a healthy
run completes all 100 cases (the test runner still reports one test method). The
seed is drawn per run; the failure prints it.

Read it in three parts:

1. **the replay** — `(1234567890,987654321)` is the seed and gamma. Record the
   pair in the ledger; the replay theory runs the same law from it.
2. **the failing input** — `Original:` is the first failing case; `Shrunk:` is
   the smallest case that still fails: the id at the documented minimum. The
   assertion shows the shrunken values, so the promotion below uses `Id = 1`.
3. **the assertion** — the law and the two values, not a generic "property
   failed".

Then promote the shrunk case into a plain `[Fact]` beside the property. The
example is readable without FsCheck, fails against the pre-fix code, and does
not depend on a generator or a seed. The ledger keeps the exact input
replayable; the named example is the durable regression evidence.

```csharp
// Promoted from the failure: a mixed-case name must survive the round trip.
[Fact]
public void RenderThenParse_WithMixedCaseName_RestoresOriginal()
{
    // Arrange
    Customer original = new Customer(1, "Alan");

    // Act
    Customer reparsed = CustomerXml.Parse(CustomerXml.Render(original));

    // Assert
    reparsed.ShouldBe(original);
}
```

## When a property is the right tool

Reach for a property when the contract states a law rather than a list:

- the contract says **always**, **never**, **every**, **no more than**,
  **round trip**, **sorted**, **unique**, or **reconciles**;
- a format/parse, serialise/deserialise, or encode/decode pair both appear —
  that pair gets a round-trip property;
- two example tests differ only in their data;
- an example table would need four or more rows to cover the range.

A finite documented domain can be enumerated exhaustively without FsCheck —
every port, every status pair. Completeness is the property there, so you do
not need shrinking. A hand-rolled _sampling_ generator is the thing to avoid:
it never shrinks.

Keep named examples where the contract is a list of cases: permissions, status
transitions, error mapping. If a trigger fires and a property is not the right
instrument, leave a why-not note immediately above the test declaration — the
gate reads only the contiguous comment block above it:

```csharp
// Why not use property here: the contract is a fixed list of status transitions
```

Silence is the failure mode; the note is the decision.

A law that exists only in the implementation is `[NEEDS DECISION]`, not a
property. Surface it to the owner; do not let a generated test settle it.

## Where this is enforced

- This page is the creation shape; [`test-review.md`](test-review.md) is the
  review catalogue. The review skill judges a property against the shape above;
  the gate's review tier will enforce the seed rule once it lands.
- The seed policy is a gate review concern: the `unrouted-property-seed` rule
  catches a per-site `Replay` literal and an even gamma. This page keeps
  `Replay` out of the properties, so a recorded seed lives in the ledger
  instead. That rule is in review separately from this page.
- The gate does not yet read a `[Property]` as a test declaration, so the
  always-on hygiene rules do not inspect these bodies. Treat the shape above as
  the review baseline until that lands.
