# Property-based tests (C# / FsCheck)

This is the shape to write when a contract states a law. It is written for an
engineer who has used `[Fact]` and `[Theory]` and is new to generated inputs.
The worked example is a round-trip law; the rules it applies are in
[`test-review.md`](test-review.md).

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

`[ProjectProperty]` is an FsCheck `[Property]` with the project seed channel
attached. When the test runner sees it:

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
using Shouldly;

public sealed class CustomerXmlPropertyTests
{
    [ProjectProperty(typeof(CustomerArbitraries))]
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
using FsCheck;
using FsCheck.Fluent;

public static class CustomerArbitraries
{
    /// <summary>Every customer the documented XML contract accepts.</summary>
    public static Arbitrary<Customer> ValidCustomer()
    {
        Gen<string> name = Gen.Elements("Ada", "Grace", "Alan");
        Gen<int> id = Gen.Choose(1, 100_000);
        Gen<Customer> customer = from customerName in name
                                 from customerId in id
                                 select new Customer(customerId, customerName);
        return Arb.From(customer);
    }
}
```

- `Arbitrary<Customer>` is the type FsCheck looks for when the method has a
  `Customer` parameter. `[ProjectProperty(typeof(CustomerArbitraries))]`
  registers it for the test class.
- `Gen<string>` and `Gen<int>` show the pieces; the query composes them into a
  `Customer`. The reader can see the documented domain without opening another
  file.
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

## The seed channel

The seed is how a failing run is reproduced. It is routing, not evidence, and
it never appears in the law.

```csharp
using FsCheck.Xunit;

public sealed class ProjectPropertyAttribute : PropertyAttribute
{
    public ProjectPropertyAttribute() : this([]) { }

    public ProjectPropertyAttribute(params Type[] arbitraryTypes)
    {
        Arbitrary = arbitraryTypes;
        Replay = $"{PropertySeed.Value},1";
    }
}
```

```csharp
using System.Globalization;

internal static class PropertySeed
{
    public const int Pin = 20261122;

    public static int Value { get; } = Resolve(
        Environment.GetEnvironmentVariable("PROPERTY_SEED"),
        IsCi,
        Random.Shared.Next);

    private static bool IsCi =>
        Environment.GetEnvironmentVariable("CI") is not null ||
        Environment.GetEnvironmentVariable("TF_BUILD") is not null;

    private static int Resolve(string? overrideSeed, bool isCi, Func<int> nextRandom)
    {
        if (overrideSeed is not null)
        {
            return int.Parse(overrideSeed, CultureInfo.InvariantCulture);
        }

        int seed = isCi ? Pin : nextRandom();
        Console.Error.WriteLine($"property seed: {seed}");
        return seed;
    }
}
```

- `Replay` is `"seed,gamma"`; the gamma must be odd, because FsCheck rejects an
  even one. `1` is the simplest valid gamma.
- `PropertySeed` resolves once per test assembly: the `PROPERTY_SEED` override
  first, then the committed `Pin` on CI (`CI` or `TF_BUILD` is set), then a
  fresh random seed locally. CI replays a known world; local runs keep
  exploring.
- Attribute arguments must be compile-time constants, which is why the
  attribute's constructor sets `Replay` at runtime. A per-site
  `Replay = "20261122,1"` freezes the world and never rotates.
- The seed belongs in test support, not in the test file. The environment read
  is the suite's one allowed ambient read, and it is confined to this helper.
- A malformed `PROPERTY_SEED` fails loudly rather than silently falling back to
  a different world.

## Where the files live

```text
tests/
  Support/ProjectPropertyAttribute.cs   seed routing, once per test project
  Support/PropertySeed.cs               the pin, the override and the local draw
  Support/CustomerArbitraries.cs        the documented domains
  CustomerXmlTests.cs                   named examples
  CustomerXmlPropertyTests.cs           laws only
```

The split is the readability rule made physical. A reader who opens
`CustomerXmlPropertyTests.cs` sees laws and nothing else; the machinery is in
`Support/` and has its own tests.

## What a failure looks like

A deliberate defect in `Parse` (uppercasing the name) produces:

```text
Falsifiable, after 1 test (0 shrinks) (20261122,1).
Original:
Customer { Id = 38560, Name = Alan }

Shouldly.ShouldAssertException : reparsed
    should be
Customer { Id = 38560, Name = Alan }
    but was
Customer { Id = 38560, Name = ALAN }
```

This run stopped after one case because the first generated value already
failed; a healthy run completes all 100 cases (the test runner still reports one
test method). The replay shown is the CI pin; locally the helper draws a fresh
seed, and the failure prints that seed.

Read it in three parts:

1. **the replay** — `(20261122,1)` is the seed and gamma. Reproduce with
   `PROPERTY_SEED=20261122 dotnet test`.
2. **the failing input** — `Customer { Id = 38560, Name = Alan }` is the case
   FsCheck settled on after shrinking. `Original:` is its label; when shrinking
   changes the value, FsCheck shows the shrunken form too.
3. **the assertion** — the law and the two values, not a generic "property
   failed".

Then promote the shrunk case into a plain `[Fact]` beside the property. The
example is readable without FsCheck, fails against the pre-fix code, and does
not depend on a generator or a seed. The property keeps the long tail; the
example is the durable regression evidence.

```csharp
// Promoted from the failure: a mixed-case name must survive the round trip.
[Fact]
public void RenderThenParse_WithMixedCaseName_RestoresOriginal()
{
    // Arrange
    Customer original = new Customer(38560, "Alan");

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
instrument, leave a why-not note beside the example table:

```csharp
// Why not use property here: the contract is a fixed list of status transitions
```

Silence is the failure mode; the note is the decision.

A law that exists only in the implementation is `[NEEDS DECISION]`, not a
property. Surface it to the owner; do not let a generated test settle it.

## Where this is enforced

- This page is the creation shape; [`test-review.md`](test-review.md) is the
  review catalogue. The review skill judges a property against the shape above;
  the gate's review tier checks the seed channel.
- The seed channel is a gate review concern: the `unrouted-property-seed` rule
  catches a literal `Replay`, an even gamma, or a seed that cannot be the
  project channel. That rule is in review separately from this page.
- The gate does not yet read a `[Property]` as a test declaration, so the
  always-on hygiene rules do not inspect these bodies. Treat the shape above as
  the review baseline until that lands.
